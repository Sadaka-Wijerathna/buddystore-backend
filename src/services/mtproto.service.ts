import { TelegramClient } from '@mtcute/node';
import { Long } from '@mtcute/core';
import pLimit from 'p-limit';
import { convertFromGramjsSession } from '@mtcute/convert';
import prisma from '../lib/prisma';
import config from '../config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────
// 5 restricted videos piped in parallel — mtcute handles per-connection concurrency internally.
const STREAM_PIPE_CONCURRENCY = 2;

// ─── In-Memory State ──────────────────────────────────────────────────────────
const activeLogins: Record<string, { tg: TelegramClient; phoneNumber: string; phoneCodeHash: string }> = {};
const activeClients: Record<string, TelegramClient> = {};
const dialogCache: Record<string, { dialogs: any[]; fetchedAt: number }> = {};
const DIALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const activeImportControllers: Record<string, { stop: boolean }> = {};
const importProgressMap: Record<string, ImportProgress> = {};

interface ImportProgress {
  status: 'idle' | 'running' | 'stopped' | 'completed' | 'failed';
  progress: number;
  total: number;
  message: string;
  error?: string;
  logs?: string[];
}

export interface TelegramAccount {
  phoneNumber: string;
  sessionString: string;
  firstName: string;
  username: string;
}

// ─── Credentials ──────────────────────────────────────────────────────────────
async function getApiCredentials() {
  let apiId = config.telegram.apiId;
  let apiHash = config.telegram.apiHash;

  if (!apiId || !apiHash) {
    const apiIdSetting = await prisma.setting.findUnique({ where: { key: 'telegram_api_id' } });
    const apiHashSetting = await prisma.setting.findUnique({ where: { key: 'telegram_api_hash' } });
    if (apiIdSetting) apiId = parseInt(apiIdSetting.value, 10);
    if (apiHashSetting) apiHash = apiHashSetting.value;
  }

  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are not configured.');
  }
  return { apiId, apiHash };
}

// ─── Session Helper ───────────────────────────────────────────────────────────
/**
 * Creates a connected TelegramClient from a stored session string.
 * Auto-detects GramJS StringSession format and converts it using @mtcute/convert.
 * New sessions saved by this service are already in mtcute format.
 */
async function buildConnectedClient(sessionString: string): Promise<TelegramClient> {
  const { apiId, apiHash } = await getApiCredentials();
  // Use a per-process temp path so each restart gets a fresh SQLite file.
  // The real session data is loaded via importSession(), not the file.
  const storagePath = path.join(os.tmpdir(), `tg_mtcute_${String(apiId).slice(-4)}`);
  const tg = new TelegramClient({ apiId, apiHash, storage: storagePath });

  // GramJS sessions start with a digit (version byte) followed by base64.
  // mtcute sessions start with 'MTX' prefix. Try conversion; fall back to direct import.
  try {
    const converted = convertFromGramjsSession(sessionString);
    await tg.importSession(converted);
  } catch {
    await (tg as any).importSession(sessionString);
  }

  await tg.connect();
  return tg;
}

// ─── Account Management ───────────────────────────────────────────────────────
export async function getAccounts(adminId: string) {
  const accountsSetting = await prisma.setting.findUnique({ where: { key: `telegram_accounts_${adminId}` } });
  const accounts: TelegramAccount[] = accountsSetting?.value ? JSON.parse(accountsSetting.value) : [];
  const activeSetting = await prisma.setting.findUnique({ where: { key: `telegram_active_account_${adminId}` } });
  const legacySetting = await prisma.setting.findUnique({ where: { key: `telegram_mtproto_session_${adminId}` } });

  return {
    accounts: accounts.map(a => ({ phoneNumber: a.phoneNumber, firstName: a.firstName, username: a.username })),
    activeAccount: activeSetting?.value || (accounts.length > 0 ? accounts[0].phoneNumber : (legacySetting ? 'legacy' : null)),
  };
}

export async function switchAccount(adminId: string, phoneNumber: string) {
  if (activeClients[adminId]) {
    try { await activeClients[adminId].disconnect(); } catch (_) {}
    delete activeClients[adminId];
  }
  delete dialogCache[adminId];

  await prisma.setting.upsert({
    where: { key: `telegram_active_account_${adminId}` },
    update: { value: phoneNumber },
    create: { key: `telegram_active_account_${adminId}`, value: phoneNumber },
  });

  try { await getConnectedClient(adminId); } catch (e) {
    console.warn('[mtproto] switchAccount: failed to pre-connect new client:', e);
  }
}



function toLong(val: any): Long {
  if (!val) return Long.ZERO;
  if (Long.isLong(val)) return val;
  try {
    return Long.fromValue(val);
  } catch {
    return Long.ZERO;
  }
}

function entityToInputPeer(entity: any): any {
  if (!entity) return entity;
  if (entity._?.startsWith('inputPeer')) return entity;
  if (entity.inputPeer) return entity.inputPeer;

  const target = entity.raw ?? entity;
  const type: string = target._ ?? target.type ?? '';

  if (type === 'channel' || type === 'channelForbidden') {
    return {
      _: 'inputPeerChannel',
      channelId: Number(target.id),
      accessHash: toLong(target.accessHash ?? target.access_hash),
    };
  }
  if (type === 'chat' || type === 'chatForbidden' || type === 'group') {
    return { _: 'inputPeerChat', chatId: Number(target.id) };
  }
  if (type === 'user') {
    return {
      _: 'inputPeerUser',
      userId: Number(target.id),
      accessHash: toLong(target.accessHash ?? target.access_hash),
    };
  }
  // Already an InputPeer or unknown type — return as-is
  return target;
}

/**
 * Resolves a Telegram entity from a username, numeric ID, public link, or private invite link.
 * Private invite links (t.me/+HASH or t.me/joinchat/HASH) cannot be resolved via getEntity;
 * we must call ImportChatInvite to join/resolve them.
 */
async function resolveEntity(tg: TelegramClient, chatIdentifier: string, adminId?: string): Promise<any> {
  const privateLinkMatch = chatIdentifier.match(
    /(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/
  );

  if (privateLinkMatch) {
    const hash = privateLinkMatch[1];
    try {
      const inviteInfo = await tg.call({ _: 'messages.checkChatInvite', hash }) as any;
      if (inviteInfo._ === 'chatInviteAlready' || inviteInfo._ === 'chatInvitePeek') {
        return entityToInputPeer(inviteInfo.chat);
      }
      const result = await tg.call({ _: 'messages.importChatInvite', hash }) as any;
      if (result?.chats?.[0]) return entityToInputPeer(result.chats[0]);
    } catch (err: any) {
      throw new Error(`Failed to resolve private invite link: ${err.message}`);
    }
  }

  // Numeric ID — GramJS uses a -100 prefix for channels/supergroups.
  // Strip it to get the bare ID that Telegram stores internally.
  if (/^-?\d+$/.test(chatIdentifier)) {
    const isChannel = chatIdentifier.startsWith('-100');
    const isGroup = !isChannel && chatIdentifier.startsWith('-');
    let bareId = chatIdentifier;
    if (isChannel) {
      bareId = chatIdentifier.slice(4);   // '-1003986179031' → '3986179031'
    } else if (isGroup) {
      bareId = chatIdentifier.slice(1);   // '-1234567' → '1234567' (basic group)
    }

    // 1. Try finding in dialogCache or fetching dialogs
    try {
      const now = Date.now();
      let entities: any[];

      if (adminId && dialogCache[adminId] && now - dialogCache[adminId].fetchedAt < DIALOG_CACHE_TTL_MS) {
        entities = dialogCache[adminId].dialogs;
      } else {
        const rawResult = await tg.call({
          _: 'messages.getDialogs',
          offsetDate: 0, offsetId: 0,
          offsetPeer: { _: 'inputPeerEmpty' },
          limit: 300, hash: Long.ZERO,
        }) as any;
        entities = [...(rawResult.chats ?? []), ...(rawResult.users ?? [])];
        if (adminId) dialogCache[adminId] = { dialogs: entities, fetchedAt: now };
      }

      // Match by bare ID, signed ID, or marked channel ID (-100...)
      // Support both mtcute Dialog objects (where id is in e.chat.id) and raw TL entities (e.id)
      const match = entities.find((e: any) => {
        const candidateIds = [
          e.id != null ? String(e.id) : null,
          e.chat?.id != null ? String(e.chat.id) : null,
          e.chat?.raw?.id != null ? String(e.chat.raw.id) : null,
        ].filter(Boolean);

        return candidateIds.some(
          id => id === bareId || id === chatIdentifier || id === `-100${bareId}`
        );
      });

      if (match) {
        if (match.chat?.inputPeer) return match.chat.inputPeer;
        return entityToInputPeer(match.chat?.raw ?? match.chat ?? match);
      }
    } catch (e) {
      console.warn('[resolveEntity] dialog lookup failed:', e);
    }

    // 2. Ask mtcute to resolve peer using numeric ID (queries internal storage or gets channel info)
    try {
      const numId = Number(chatIdentifier);
      const peer = await tg.resolvePeer(numId);
      if (peer) return peer;
    } catch (e) {
      console.warn(`[resolveEntity] tg.resolvePeer(${chatIdentifier}) failed:`, e);
    }

    // 3. Also try resolving with marked channel ID (-100...) if not already attempted
    if (!isChannel) {
      try {
        const markedId = Number(`-100${bareId}`);
        const peer = await tg.resolvePeer(markedId);
        if (peer) return peer;
      } catch (e) {
        console.warn(`[resolveEntity] tg.resolvePeer(-100${bareId}) failed:`, e);
      }
    }

    // 4. Fetch fresh dialogs bypassing cache
    try {
      const freshResult = await tg.call({
        _: 'messages.getDialogs',
        offsetDate: 0, offsetId: 0,
        offsetPeer: { _: 'inputPeerEmpty' },
        limit: 500, hash: Long.ZERO,
      }) as any;
      const allChats = [...(freshResult.chats ?? []), ...(freshResult.users ?? [])];
      const freshMatch = allChats.find((c: any) =>
        String(c.id) === bareId || String(c.id) === chatIdentifier || String(c.id) === `-100${bareId}`
      );
      if (freshMatch) return entityToInputPeer(freshMatch);
    } catch (e) {
      console.warn('[resolveEntity] fresh getDialogs lookup failed:', e);
    }

    if (isGroup) {
      return { _: 'inputPeerChat', chatId: Number(bareId) };
    }

    throw new Error(
      `Channel ${chatIdentifier} could not be resolved with a valid access hash. Please ensure the logged-in Telegram account is a member of this channel, or use its public @username or private invite link (t.me/+...).`
    );
  }

  // Username / public link — mtcute resolves internally
  return tg.resolvePeer(chatIdentifier as any);
}


/**
 * Checks if a Telegram message contains a video document (mtcute).
 */
function isVideoMessage(msg: any): boolean {
  if (msg._ !== 'message' || !msg.media) return false;
  if (msg.media._ === 'messageMediaDocument' && msg.media.document?._ === 'document') {
    const doc = msg.media.document;
    return (
      (doc.mimeType?.startsWith('video/') ?? false) ||
      (doc.attributes?.some((a: any) => a._ === 'documentAttributeVideo') ?? false)
    );
  }
  return false;
}

/**
 * Returns a connected and authenticated TelegramClient instance if a session exists.
 */
export async function getConnectedClient(adminId: string): Promise<TelegramClient | null> {
  if (activeClients[adminId]) {
    try {
      await activeClients[adminId].getMe();
      return activeClients[adminId];
    } catch {
      try { await activeClients[adminId].disconnect(); } catch (_) {}
      delete activeClients[adminId];
    }
  }

  let sessionString = '';
  const accountsSetting = await prisma.setting.findUnique({ where: { key: `telegram_accounts_${adminId}` } });
  const accounts: TelegramAccount[] = accountsSetting?.value ? JSON.parse(accountsSetting.value) : [];

  if (accounts.length > 0) {
    const activeSetting = await prisma.setting.findUnique({ where: { key: `telegram_active_account_${adminId}` } });
    const activePhone = activeSetting?.value || accounts[0].phoneNumber;
    const activeAccount = accounts.find(a => a.phoneNumber === activePhone) || accounts[0];
    sessionString = activeAccount.sessionString;
    if (!activeSetting || activeSetting.value !== activeAccount.phoneNumber) {
      await prisma.setting.upsert({
        where: { key: `telegram_active_account_${adminId}` },
        update: { value: activeAccount.phoneNumber },
        create: { key: `telegram_active_account_${adminId}`, value: activeAccount.phoneNumber },
      });
    }
  } else {
    const sessionSetting = await prisma.setting.findUnique({ where: { key: `telegram_mtproto_session_${adminId}` } });
    if (!sessionSetting?.value) return null;
    sessionString = sessionSetting.value;
  }

  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      const tg = await buildConnectedClient(sessionString);
      await tg.getMe(); // verify auth
      activeClients[adminId] = tg;
      return tg;
    } catch (err: any) {
      if (err?.message?.includes('AUTH_KEY_DUPLICATED') && attempt < 5) {
        console.warn(`[mtproto] AUTH_KEY_DUPLICATED for admin ${adminId}, retrying in 5s... (${5 - attempt} left)`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      console.warn(`[mtproto] Failed to connect for admin ${adminId}:`, err?.message || err);
      return null;
    }
  }
  return null;
}

export async function logoutClient(adminId: string, phoneNumberToLogout?: string) {
  const activeSetting = await prisma.setting.findUnique({ where: { key: `telegram_active_account_${adminId}` } });
  const targetPhone = phoneNumberToLogout || activeSetting?.value;

  if (!targetPhone) {
    if (activeClients[adminId]) {
      try { await activeClients[adminId].disconnect(); } catch (_) {}
      delete activeClients[adminId];
    }
    await prisma.setting.deleteMany({ where: { key: `telegram_mtproto_session_${adminId}` } });
    return;
  }

  const accountsSetting = await prisma.setting.findUnique({ where: { key: `telegram_accounts_${adminId}` } });
  let accounts: TelegramAccount[] = accountsSetting?.value ? JSON.parse(accountsSetting.value) : [];
  const isLoggingOutActive = activeSetting?.value === targetPhone;

  if (isLoggingOutActive && activeClients[adminId]) {
    try { await activeClients[adminId].disconnect(); } catch (_) {}
    delete activeClients[adminId];
  }

  accounts = accounts.filter(a => a.phoneNumber !== targetPhone);

  if (accounts.length > 0) {
    await prisma.setting.upsert({ where: { key: `telegram_accounts_${adminId}` }, update: { value: JSON.stringify(accounts) }, create: { key: `telegram_accounts_${adminId}`, value: JSON.stringify(accounts) } });
    if (isLoggingOutActive) {
      await prisma.setting.update({ where: { key: `telegram_active_account_${adminId}` }, data: { value: accounts[0].phoneNumber } });
    }
  } else {
    await prisma.setting.deleteMany({ where: { key: `telegram_accounts_${adminId}` } });
    await prisma.setting.deleteMany({ where: { key: `telegram_active_account_${adminId}` } });
    await prisma.setting.deleteMany({ where: { key: `telegram_mtproto_session_${adminId}` } });
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export async function sendCode(adminId: string, phoneNumber: string) {
  const { apiId, apiHash } = await getApiCredentials();
  if (activeLogins[adminId]) {
    try { await activeLogins[adminId].tg.disconnect(); } catch (_) {}
    delete activeLogins[adminId];
  }
  const storagePath = path.join(os.tmpdir(), `tg_login_${String(apiId).slice(-4)}_${adminId}`);
  const tg = new TelegramClient({ apiId, apiHash, storage: storagePath });
  await tg.connect();
  const codeRes = await tg.sendCode({ phone: phoneNumber });
  const phoneCodeHash = 'phoneCodeHash' in codeRes ? codeRes.phoneCodeHash : '';
  activeLogins[adminId] = { tg, phoneNumber, phoneCodeHash };
  return { phoneCodeHash };
}

export async function login(adminId: string, code: string, password?: string) {
  const loginSession = activeLogins[adminId];
  if (!loginSession) throw new Error('No active login session. Please send the code first.');

  const { tg, phoneNumber, phoneCodeHash } = loginSession;
  try {
    try {
      await tg.signIn({ phone: phoneNumber, phoneCodeHash, phoneCode: code });
    } catch (err: any) {
      if (err?.message?.includes('SESSION_PASSWORD_NEEDED')) {
        if (!password) return { success: true, needsPassword: true };
        await tg.checkPassword(password);
      } else {
        throw err;
      }
    }

    const sessionString = await tg.exportSession();
    const me = await tg.getMe() as any;
    const newAccount: TelegramAccount = {
      phoneNumber,
      sessionString,
      firstName: me.firstName || me.first_name || '',
      username: me.username || '',
    };

    const accountsSetting = await prisma.setting.findUnique({ where: { key: `telegram_accounts_${adminId}` } });
    let accounts: TelegramAccount[] = accountsSetting?.value ? JSON.parse(accountsSetting.value) : [];
    const existingIndex = accounts.findIndex(a => a.phoneNumber === phoneNumber);
    if (existingIndex >= 0) accounts[existingIndex] = newAccount;
    else accounts.push(newAccount);

    await prisma.setting.upsert({ where: { key: `telegram_accounts_${adminId}` }, update: { value: JSON.stringify(accounts) }, create: { key: `telegram_accounts_${adminId}`, value: JSON.stringify(accounts) } });
    await prisma.setting.upsert({ where: { key: `telegram_active_account_${adminId}` }, update: { value: phoneNumber }, create: { key: `telegram_active_account_${adminId}`, value: phoneNumber } });

    activeClients[adminId] = tg;
    delete activeLogins[adminId];
    return { success: true, needsPassword: false };
  } catch (err) {
    try { await tg.disconnect(); } catch (_) {}
    delete activeLogins[adminId];
    throw err;
  }
}

export function stopImport(adminId: string) {
  const controller = activeImportControllers[adminId];
  if (controller) {
    controller.stop = true;
  }
  const inMemory = importProgressMap[adminId];
  if (inMemory) {
    inMemory.status = 'stopped';
    inMemory.message = 'Import cancellation requested...';
    if (!inMemory.logs) inMemory.logs = [];
    inMemory.logs.push(`[${new Date().toLocaleTimeString()}] Stop requested by admin.`);
  }
}

/**
 * Starts importing videos from the source chat and forwards them to target bot.
 * Supports resumeJobId for resuming interrupted imports.
 * startMessageId / endMessageId define an optional message ID range (inclusive).
 */
// @ts-ignore
import type { Prisma } from '@prisma/client';

async function updateJobProgress(
  jobId: string,
  adminId: string,
  updates: {
    status?: 'IDLE' | 'RUNNING' | 'STOPPED' | 'COMPLETED' | 'FAILED';
    progress?: number;
    total?: number;
    message?: string;
    error?: string;
  },
  newLog?: string,
  dbWrite: boolean = true
) {
  const inMemory = importProgressMap[adminId] || {
    status: 'idle',
    progress: 0,
    total: 0,
    message: '',
    logs: [],
  };

  if (updates.status) inMemory.status = updates.status.toLowerCase() as any;
  if (updates.progress !== undefined) inMemory.progress = updates.progress;
  if (updates.total !== undefined) inMemory.total = updates.total;
  if (updates.message !== undefined) inMemory.message = updates.message;
  if (updates.error !== undefined) inMemory.error = updates.error;

  if (newLog) {
    if (!inMemory.logs) inMemory.logs = [];
    inMemory.logs.push(`[${new Date().toLocaleTimeString()}] ${newLog}`);
    const MAX_LOG_LINES = 500;
    if (inMemory.logs.length > MAX_LOG_LINES) {
      inMemory.logs = inMemory.logs.slice(-MAX_LOG_LINES);
    }
  }

  importProgressMap[adminId] = inMemory;
  if (!dbWrite) return;

  try {
    await prisma.telegramImportJob.update({
      where: { id: jobId },
      data: {
        status: updates.status || undefined,
        progress: updates.progress !== undefined ? updates.progress : undefined,
        total: updates.total !== undefined ? updates.total : undefined,
        message: updates.message || undefined,
        error: updates.error || undefined,
        logs: inMemory.logs ? JSON.stringify(inMemory.logs) : undefined,
      },
    });
  } catch (dbErr) {
    console.error('Failed to update import job in database:', dbErr);
  }
}

export async function startImport(
  adminId: string,
  sourceChat: string,
  targetBot: string,
  resumeJobId?: string,
  limitCount?: number,
  skipExisting: boolean = true,
  startMessageId?: number,
  endMessageId?: number
) {
  const currentProgress = importProgressMap[adminId];
  if (currentProgress && currentProgress.status === 'running') {
    throw new Error('An import task is already running for this session.');
  }

  const tg = await getConnectedClient(adminId);
  if (!tg) throw new Error('Telegram client is not authenticated.');

  let job;
  if (resumeJobId) {
    job = await prisma.telegramImportJob.findUnique({ where: { id: resumeJobId } });
    if (!job) throw new Error(`Job not found: ${resumeJobId}`);
    await prisma.telegramImportJob.update({
      where: { id: resumeJobId },
      data: { status: 'RUNNING', message: 'Resuming import...', updatedAt: new Date() },
    });
  } else {
    job = await prisma.telegramImportJob.create({
      data: {
        adminId, sourceChat, targetBot, status: 'RUNNING', progress: 0, total: 0,
        limitCount, skipExisting, startMessageId: startMessageId ?? null,
        endMessageId: endMessageId ?? null, message: 'Initializing...',
        logs: JSON.stringify([`[${new Date().toLocaleTimeString()}] Initializing...`]),
      },
    });
  }

  importProgressMap[adminId] = {
    status: 'running',
    progress: resumeJobId ? job.progress : 0,
    total: resumeJobId ? job.total : 0,
    message: resumeJobId ? 'Resuming...' : 'Initializing...',
    logs: [`[${new Date().toLocaleTimeString()}] Started...`],
  };

  activeImportControllers[adminId] = { stop: false };
  const controller = activeImportControllers[adminId];

  (async () => {
    try {
      await updateJobProgress(job.id, adminId, { message: 'Resolving handles...' }, 'Resolving...');
      const sourceEntity = await resolveEntity(tg, sourceChat, adminId);
      const targetEntity = await resolveEntity(tg, targetBot.replace(/^@+/, '@'), adminId);

      const botHandle = targetBot.replace(/^@+/, '');
      const targetBotDb = await prisma.bot.findUnique({ where: { name: botHandle } });
      const targetBotDbId = targetBotDb?.id;

      await updateJobProgress(job.id, adminId, { message: 'Scanning videos...' }, 'Scanning...');

      let lastMsgId: number | undefined;
      const skipExistingCheck = resumeJobId ? job.skipExisting : skipExisting;
      const jobLimit = resumeJobId ? job.limitCount : limitCount;

      if (skipExistingCheck) {
        const key = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
        const setting = await prisma.setting.findUnique({ where: { key } });
        if (setting?.value) lastMsgId = parseInt(setting.value, 10);
      }

      const videoIds: number[] = [];
      const jobStartId = resumeJobId ? (job.startMessageId ?? undefined) : startMessageId;
      const jobEndId = resumeJobId ? (job.endMessageId ?? undefined) : endMessageId;

      let offsetId = jobStartId ? jobStartId - 1 : (lastMsgId ?? 0);
      
      let scanTick = 0;
      let hasMore = true;

      // Use lower-level search directly for reliable pagination with offsetId
      while (hasMore) {
        if (controller.stop) break;

        const res = await tg.call({
          _: 'messages.search',
          peer: sourceEntity as any,
          q: '',
          filter: { _: 'inputMessagesFilterVideo' },
          minDate: 0,
          maxDate: 0,
          offsetId,
          addOffset: 0,
          limit: 100,
          maxId: 0,
          minId: 0,
          hash: Long.ZERO,
        }) as any;

        const messages = res.messages || [];
        if (!messages.length) {
          hasMore = false;
          break;
        }

        for (const msg of messages) {
          if (controller.stop) break;
          if (jobEndId && msg.id > jobEndId) continue;
          
          videoIds.push(msg.id);
          scanTick++;
          offsetId = msg.id; // prepare for next offset
        }

        if (scanTick % 100 === 0 && importProgressMap[adminId]) {
          importProgressMap[adminId].message = `Scanning... ${scanTick} found`;
          importProgressMap[adminId].total = scanTick;
        }

        if (messages.length < 100) {
          hasMore = false;
        }
      }

      if (controller.stop) {
        await updateJobProgress(job.id, adminId, { status: 'STOPPED' }, 'Stopped during scan.');
        return;
      }

      videoIds.reverse();
      let totalVideos = videoIds.length;
      if (jobLimit && totalVideos > jobLimit) {
        videoIds.splice(jobLimit);
        totalVideos = jobLimit;
      }

      if (totalVideos === 0) {
        await updateJobProgress(job.id, adminId, { status: 'COMPLETED', total: 0 }, 'No videos found.');
        return;
      }

      const startIndex = resumeJobId ? job.progress : 0;
      await updateJobProgress(job.id, adminId, { total: totalVideos, progress: startIndex }, `Forwarding ${totalVideos} videos...`);

      const limit = pLimit(STREAM_PIPE_CONCURRENCY);
      const uploadPromises: Promise<void>[] = [];
      let processedCount = startIndex;

      for (let i = startIndex; i < totalVideos; i++) {
        if (controller.stop) {
          await updateJobProgress(job.id, adminId, { status: 'STOPPED' }, 'Stopped by admin.');
          return;
        }

        uploadPromises.push(limit(async () => {
          if (controller.stop) return;

          const msgId = videoIds[i];
          try {
            const msgs = await tg.getMessages(sourceEntity, msgId);
            const msg = msgs[0];
            if (!msg || !msg.media) {
              processedCount++;
              await updateJobProgress(job.id, adminId, { progress: processedCount }, `Skipped ${msgId}: no media.`);
              return;
            }

            if (targetBotDbId && (msg.media.type === 'document' || msg.media.type === 'video') && (msg.media as any).fileSize) {
              const fileSize = String((msg.media as any).fileSize || 0);
              const duration = (msg.media as any).duration || 0;
              const existing = await prisma.videos.findFirst({
                where: { botId: targetBotDbId, fileSize, duration }
              });
              if (existing) {
                processedCount++;
                await updateJobProgress(job.id, adminId, { progress: processedCount }, `[Duplicate] Skipped video (Size: ${fileSize}, Duration: ${duration}s) - Already in DB.`);
                return;
              }
            }

            const stream = await tg.downloadAsStream(msg.media as any);
            
            let fileName = `video_${msg.id}.mp4`;
            if (msg.media.type === 'document' && msg.media.fileName) {
              fileName = (msg.media as any).fileName || fileName;
            }

            await tg.sendMedia(targetEntity, {
              type: 'document',
              file: stream,
              fileName: fileName,
              caption: msg.text || ''
            } as any);

            processedCount++;
            await updateJobProgress(job.id, adminId, { progress: processedCount }, `Imported video ${processedCount}/${totalVideos}`);

            if (skipExistingCheck) {
              const key = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
              await prisma.setting.upsert({
                where: { key },
                update: { value: msg.id.toString() },
                create: { key, value: msg.id.toString() },
              });
            }

          } catch (err: any) {
            processedCount++;
            await updateJobProgress(job.id, adminId, { progress: processedCount }, `Error on ${msgId}: ${err.message}`);
          }
        }));
      }

      await Promise.all(uploadPromises);

      if (controller.stop) {
        await updateJobProgress(job.id, adminId, { status: 'STOPPED' }, 'Stopped by admin.');
        return;
      }

      await updateJobProgress(job.id, adminId, { status: 'COMPLETED' }, 'Import completed.');

    } catch (err: any) {
      await updateJobProgress(job.id, adminId, { status: 'FAILED' }, `Fatal Error: ${err.message}`);
    } finally {
      if (activeImportControllers[adminId]) {
        delete activeImportControllers[adminId];
      }
    }
  })();

  return { jobId: job.id, message: 'Import background worker started' };
}

export async function countVideos(adminId: string, sourceChat: string): Promise<number> {
  const tg = await getConnectedClient(adminId);
  if (!tg) throw new Error('Not authenticated.');
  const peer = await resolveEntity(tg, sourceChat, adminId);
  const result = await tg.call({
    _: 'messages.search',
    peer: peer as any,
    q: '',
    filter: { _: 'inputMessagesFilterVideo' },
    minDate: 0,
    maxDate: 0,
    offsetId: 0,
    addOffset: 0,
    limit: 1,
    maxId: 0,
    minId: 0,
    hash: Long.ZERO,
  }) as any;
  return result.count ?? 0;
}

export async function getCheckpoint(sourceChat: string, targetBot: string) {
  const key = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
  const setting = await prisma.setting.findUnique({ where: { key } });
  const lastMsgId = setting?.value ? parseInt(setting.value, 10) : null;
  const botHandle = targetBot.replace(/^@/, '');
  const bot = await prisma.bot.findUnique({ where: { name: botHandle } });
  const importedCount = bot ? await prisma.videos.count({ where: { botId: bot.id } }) : 0;
  return { lastMsgId, importedCount };
}

export async function listChats(adminId: string) {
  const tg = await getConnectedClient(adminId);
  if (!tg) throw new Error('Not authenticated.');
  let dialogs: any[] = [];
  const now = Date.now();
  if (dialogCache[adminId] && (now - dialogCache[adminId].fetchedAt < DIALOG_CACHE_TTL_MS)) {
    dialogs = dialogCache[adminId].dialogs;
  } else {
    // We can use iterDialogs here without issue
    for await (const dialog of tg.iterDialogs({ limit: 100 })) {
      dialogs.push(dialog);
    }
    dialogCache[adminId] = { dialogs, fetchedAt: now };
  }

  const chats = dialogs
    .map(d => {
      // dialogCache can be populated by either iterDialogs (gives {chat: {...}})
      // or resolveEntity/messages.getDialogs (gives raw entities with id/title directly).
      // Use d.chat ?? d to handle both shapes safely.
      const chat = d.chat ?? d;
      if (!chat || chat.id == null) return null;
      return {
        id: String(chat.id),
        title: chat.title || chat.displayName || '',
        username: chat.username || '',
        isChannel: chat.type === 'channel',
        isGroup: chat.type === 'group' || chat.type === 'supergroup',
      };
    })
    .filter((c): c is NonNullable<typeof c> => !!(c && (c.title || c.username)));
  return chats;
}


export async function getStatus(adminId: string) {
  if (importProgressMap[adminId]) {
    return importProgressMap[adminId];
  }

  try {
    const lastJob = await prisma.telegramImportJob.findFirst({
      where: { adminId },
      orderBy: { updatedAt: 'desc' },
    });

    if (lastJob) {
      return {
        status: lastJob.status.toLowerCase(),
        progress: lastJob.progress || 0,
        total: lastJob.total || 0,
        message: lastJob.message || '',
        logs: lastJob.logs ? JSON.parse(lastJob.logs as string) : [],
      };
    }
  } catch (dbErr) {
    console.error('[getStatus] DB fallback failed:', dbErr);
  }

  return {
    status: 'idle',
    progress: 0,
    total: 0,
    message: 'No active import',
    logs: [],
  };
}

