import { TelegramClient, Api } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { StringSession } from 'telegram/sessions';
import { Logger } from 'telegram/extensions/Logger';
import prisma from '../lib/prisma';
import config from '../config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Stream Piping Constants ──────────────────────────────────────────────────
// Default chunk size, dynamically scaled up for files >2GB inside the pipe loop.
const DEFAULT_STREAM_CHUNK_SIZE = 512 * 1024; // 512 KB
// Reduced to 2 videos processed in parallel for Render server limits.
const STREAM_PIPE_CONCURRENCY = 2;

/**
 * Async mutex that serializes concurrent async operations through a shared lock.
 * Used to ensure only ONE SaveBigFilePart upload is in flight on the main client
 * at a time, preventing "hanging states" on the main MTProto sender.
 */
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  /** Run fn exclusively — waits for any in-progress fn to finish first. */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    // Absorb errors so the queue chain never breaks
    this.queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}

// Active login clients map (key: adminId)
const activeLogins: Record<string, { client: TelegramClient; phoneNumber: string; phoneCodeHash?: string }> = {};

// Active connected clients map (key: adminId)
const activeClients: Record<string, TelegramClient> = {};

// Cache for listChats dialogs (key: adminId)
const dialogCache: Record<string, { dialogs: any[]; fetchedAt: number }> = {};
const DIALOG_CACHE_TTL_MS = 5 * 60 * 1000; // Cache for 5 minutes

// Active import controllers (key: adminId)
const activeImportControllers: Record<string, { stop: boolean }> = {};

interface ImportProgress {
  status: 'idle' | 'running' | 'stopped' | 'completed' | 'failed';
  progress: number;
  total: number;
  message: string;
  error?: string;
  logs?: string[];
}

// Stream Piping: restricted videos are relayed chunk-by-chunk (512 KB at a time) directly
// from the download DC to the upload DC — zero disk usage, ~512 KB RAM per active transfer.
// Up to STREAM_PIPE_CONCURRENCY videos can be piped in parallel safely.

const importProgressMap: Record<string, ImportProgress> = {};

export interface TelegramAccount {
  phoneNumber: string;
  sessionString: string;
  firstName: string;
  username: string;
}

export async function getAccounts(adminId: string) {
  const accountsSetting = await prisma.setting.findUnique({
    where: { key: `telegram_accounts_${adminId}` },
  });
  const accounts: TelegramAccount[] = accountsSetting && accountsSetting.value ? JSON.parse(accountsSetting.value) : [];
  
  const activeSetting = await prisma.setting.findUnique({
    where: { key: `telegram_active_account_${adminId}` },
  });
  
  const legacySetting = await prisma.setting.findUnique({
    where: { key: `telegram_mtproto_session_${adminId}` },
  });

  return {
    accounts: accounts.map(a => ({ phoneNumber: a.phoneNumber, firstName: a.firstName, username: a.username })),
    activeAccount: activeSetting?.value || (accounts.length > 0 ? accounts[0].phoneNumber : (legacySetting ? "legacy" : null))
  };
}

export async function switchAccount(adminId: string, phoneNumber: string) {
  if (activeClients[adminId]) {
    try { await activeClients[adminId].disconnect(); } catch (_) {}
    delete activeClients[adminId];
  }

  // Bug 7 Fix: clear the dialog cache so the new account's chats are fetched fresh.
  // Without this, the dropdown serves the old account's channels for up to 5 minutes.
  delete dialogCache[adminId];
  
  await prisma.setting.upsert({
    where: { key: `telegram_active_account_${adminId}` },
    update: { value: phoneNumber },
    create: { key: `telegram_active_account_${adminId}`, value: phoneNumber },
  });

  // Bug 3 Fix: proactively connect the new account's client so the status endpoint
  // returns authorized:true immediately after the switch (instead of waiting for the
  // next API call to trigger a lazy reconnect).
  try {
    await getConnectedClient(adminId);
  } catch (connectErr) {
    console.warn('[mtproto] switchAccount: failed to pre-connect new client:', connectErr);
    // Non-fatal — the next request will retry the connection.
  }
}


/**
 * Helper to fetch API ID and Hash.
 * Prioritizes environment variables, falls back to settings database table.
 */
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
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are not configured. Please add them to your environment or settings.');
  }

  return { apiId, apiHash };
}

/**
 * Resolves a Telegram entity from a username, numeric ID, public link, or private invite link.
 * Private invite links (t.me/+HASH or t.me/joinchat/HASH) cannot be resolved via getEntity;
 * we must call ImportChatInvite to join/resolve them.
 */
async function resolveEntity(client: TelegramClient, chatIdentifier: string, adminId?: string) {
  // Match private invite link formats:
  //   https://t.me/+ABCDEF
  //   https://t.me/joinchat/ABCDEF
  //   t.me/+ABCDEF  (without protocol)
  const privateLinkMatch = chatIdentifier.match(
    /(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/
  );

  if (privateLinkMatch) {
    const hash = privateLinkMatch[1];
    try {
      // Check the invite link first.
      // If we are already a member, this returns Api.ChatInviteAlready containing the chat entity.
      // If not, it returns Api.ChatInvite, so we join it.
      const inviteInfo = await client.invoke(
        new Api.messages.CheckChatInvite({ hash })
      );

      if (inviteInfo instanceof Api.ChatInviteAlready) {
        return inviteInfo.chat;
      }

      // Not a member yet — join it
      const result = await client.invoke(
        new Api.messages.ImportChatInvite({ hash })
      ) as any;
      if (result?.chats?.[0]) {
        return result.chats[0];
      }
    } catch (err: any) {
      throw new Error(`Failed to resolve private invite link: ${err.message || err.errorMessage}`);
    }
  }

  // Handle pure numeric IDs (selected from dialog list) — look up via dialogs for proper access hash
  if (/^-?\d+$/.test(chatIdentifier)) {
    try {
      let dialogs = [];
      const now = Date.now();
      if (adminId && dialogCache[adminId] && (now - dialogCache[adminId].fetchedAt < DIALOG_CACHE_TTL_MS)) {
        dialogs = dialogCache[adminId].dialogs;
      } else {
        dialogs = await client.getDialogs({ limit: 300 });
        if (adminId) {
          dialogCache[adminId] = { dialogs, fetchedAt: now };
        }
      }
      const match = dialogs.find((d) => {
        const e = d.entity as any;
        return e?.id?.toString() === chatIdentifier;
      });
      if (match?.entity) return match.entity;
    } catch (dialogErr) {
      console.warn('Could not look up entity from dialogs, falling back to getEntity:', dialogErr);
    }
  }

  // Standard resolution for @username, public links, or numeric IDs
  return client.getEntity(chatIdentifier);
}

/**
 * Checks if a Telegram message contains a video document.
 * Uses client-side detection because messages.search (filter-based) is capped/unreliable
 * for save-restricted channels — we iterate getHistory instead.
 */
function isVideoMessage(msg: Api.Message): boolean {
  if (!msg?.media) return false;
  if (msg.media instanceof Api.MessageMediaDocument) {
    const doc = msg.media.document;
    if (doc instanceof Api.Document) {
      return (
        (doc.mimeType?.startsWith('video/') ?? false) ||
        (doc.attributes?.some((a) => a instanceof Api.DocumentAttributeVideo) ?? false)
      );
    }
  }
  return false;
}

/**
 * Returns a connected and authenticated TelegramClient instance if a session exists.
 */
export async function getConnectedClient(adminId: string): Promise<TelegramClient | null> {
  if (activeClients[adminId] && activeClients[adminId].connected) {
    try {
      if (await activeClients[adminId].checkAuthorization()) {
        return activeClients[adminId];
      }
    } catch (err) {
      console.warn(`Client check authorization failed for admin ${adminId}, attempting reconnect...`, err);
    }
  }

  // Forcefully disconnect any stale in-memory client before creating a new one.
  // Without this, a server restart leaves the old auth key open on Telegram's end
  // and the new connection receives AUTH_KEY_DUPLICATED (error 406).
  if (activeClients[adminId]) {
    try {
      await activeClients[adminId].disconnect();
    } catch (_) {}
    delete activeClients[adminId];
  }

  let sessionString = '';
  const accountsSetting = await prisma.setting.findUnique({
    where: { key: `telegram_accounts_${adminId}` },
  });
  const accounts: TelegramAccount[] = accountsSetting && accountsSetting.value ? JSON.parse(accountsSetting.value) : [];

  if (accounts.length > 0) {
    const activeSetting = await prisma.setting.findUnique({
      where: { key: `telegram_active_account_${adminId}` },
    });
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
    const sessionSetting = await prisma.setting.findUnique({
      where: { key: `telegram_mtproto_session_${adminId}` },
    });
    if (!sessionSetting || !sessionSetting.value) {
      return null;
    }
    sessionString = sessionSetting.value;
  }

  const { apiId, apiHash } = await getApiCredentials();

  const tryConnect = async (retries = 5): Promise<TelegramClient | null> => {
    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: 5,
      useWSS: true,
      baseLogger: new Logger('warn' as any),
    });

    try {
      await client.connect();

      if (await client.checkAuthorization()) {
        activeClients[adminId] = client;
        return client;
      }

      await client.disconnect();
      return null;
    } catch (err: any) {
      try { await client.disconnect(); } catch (_) {}

      // Telegram keeps the old key alive briefly after a process restart.
      // Wait 5 s and retry — the conflict clears itself quickly.
      // Render redeploys fast, so we give up to 5 retries (25s total).
      if (err?.errorMessage === 'AUTH_KEY_DUPLICATED' && retries > 0) {
        console.warn(`[mtproto] AUTH_KEY_DUPLICATED for admin ${adminId}, retrying in 5 s... (${retries} left)`);
        await new Promise(r => setTimeout(r, 5000));
        return tryConnect(retries - 1);
      }

      console.warn(`[mtproto] Failed to connect MTProto client for admin ${adminId}:`, err?.errorMessage || err?.message || err);
      return null;
    }
  };

  return tryConnect();
}

/**
 * Disconnect and clear the current session.
 */
export async function logoutClient(adminId: string, phoneNumberToLogout?: string) {
  const activeSetting = await prisma.setting.findUnique({
    where: { key: `telegram_active_account_${adminId}` },
  });
  
  const targetPhone = phoneNumberToLogout || activeSetting?.value;
  
  if (!targetPhone) {
    if (activeClients[adminId]) {
      try { await activeClients[adminId].disconnect(); } catch (_) {}
      delete activeClients[adminId];
    }
    await prisma.setting.deleteMany({
      where: { key: `telegram_mtproto_session_${adminId}` },
    });
    return;
  }

  const accountsSetting = await prisma.setting.findUnique({
    where: { key: `telegram_accounts_${adminId}` },
  });
  let accounts: TelegramAccount[] = accountsSetting && accountsSetting.value ? JSON.parse(accountsSetting.value) : [];
  
  const isLoggingOutActive = activeSetting?.value === targetPhone;
  
  if (isLoggingOutActive && activeClients[adminId]) {
    try { await activeClients[adminId].disconnect(); } catch (_) {}
    delete activeClients[adminId];
  }
  
  accounts = accounts.filter(a => a.phoneNumber !== targetPhone);
  
  if (accounts.length > 0) {
    await prisma.setting.upsert({
      where: { key: `telegram_accounts_${adminId}` },
      update: { value: JSON.stringify(accounts) },
      create: { key: `telegram_accounts_${adminId}`, value: JSON.stringify(accounts) },
    });
    
    if (isLoggingOutActive) {
      await prisma.setting.update({
        where: { key: `telegram_active_account_${adminId}` },
        data: { value: accounts[0].phoneNumber }
      });
    }
  } else {
    await prisma.setting.deleteMany({ where: { key: `telegram_accounts_${adminId}` } });
    await prisma.setting.deleteMany({ where: { key: `telegram_active_account_${adminId}` } });
    await prisma.setting.deleteMany({ where: { key: `telegram_mtproto_session_${adminId}` } });
  }
}

/**
 * Sends a phone code verification to the phone number.
 */
export async function sendCode(adminId: string, phoneNumber: string) {
  const { apiId, apiHash } = await getApiCredentials();

  // Clean up any existing active login client for this admin
  if (activeLogins[adminId]) {
    try {
      await activeLogins[adminId].client.disconnect();
    } catch (_) {}
    delete activeLogins[adminId];
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
    useWSS: true,
    baseLogger: new Logger('warn' as any),
  });

  await client.connect();

  const result = await client.sendCode(
    { apiId, apiHash },
    phoneNumber
  );

  activeLogins[adminId] = {
    client,
    phoneNumber,
    phoneCodeHash: result.phoneCodeHash,
  };

  return {
    phoneCodeHash: result.phoneCodeHash,
    isCodeViaApp: result.isCodeViaApp,
  };
}

/**
 * Submits the code and optional 2FA password to complete login.
 */
export async function login(adminId: string, code: string, password?: string) {
  const loginSession = activeLogins[adminId];
  if (!loginSession) {
    throw new Error('No active login session found. Please send the code first.');
  }

  const { client, phoneNumber, phoneCodeHash } = loginSession;
  const { apiId, apiHash } = await getApiCredentials();

  try {
    let user;
    try {
      user = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash: phoneCodeHash || '',
          phoneCode: code,
        })
      );
    } catch (err: any) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        if (!password) {
          return { success: true, needsPassword: true };
        }
        // Password provided, attempt login using password
        user = await client.signInWithPassword(
          { apiId, apiHash },
          {
            password: async () => password,
            onError: (e) => {
              throw e;
            },
          }
        );
      } else {
        throw err;
      }
    }

    if (!user) {
      throw new Error('Authentication failed. User object is null.');
    }

    const sessionString = (client.session.save() as unknown as string) || '';

    const me = await client.getMe() as Api.User;
    const newAccount: TelegramAccount = {
      phoneNumber,
      sessionString,
      firstName: me.firstName || '',
      username: me.username || ''
    };

    const accountsSetting = await prisma.setting.findUnique({
      where: { key: `telegram_accounts_${adminId}` },
    });
    let accounts: TelegramAccount[] = accountsSetting && accountsSetting.value ? JSON.parse(accountsSetting.value) : [];
    
    const existingIndex = accounts.findIndex(a => a.phoneNumber === phoneNumber);
    if (existingIndex >= 0) {
      accounts[existingIndex] = newAccount;
    } else {
      accounts.push(newAccount);
    }

    await prisma.setting.upsert({
      where: { key: `telegram_accounts_${adminId}` },
      update: { value: JSON.stringify(accounts) },
      create: { key: `telegram_accounts_${adminId}`, value: JSON.stringify(accounts) },
    });
    
    await prisma.setting.upsert({
      where: { key: `telegram_active_account_${adminId}` },
      update: { value: phoneNumber },
      create: { key: `telegram_active_account_${adminId}`, value: phoneNumber },
    });

    activeClients[adminId] = client;
    delete activeLogins[adminId];

    return { success: true, needsPassword: false };
  } catch (err) {
    // If auth fails completely, ensure we cleanup the client
    try {
      await client.disconnect();
    } catch (_) {}
    delete activeLogins[adminId];
    throw err;
  }
}

/**
 * Gets the current import progress status.
 * Falls back to the most recent DB job when the in-memory map is empty
 * (e.g. after a server restart / Render cold-start).
 */
export async function getStatus(adminId: string): Promise<ImportProgress> {
  if (importProgressMap[adminId]) {
    return importProgressMap[adminId];
  }

  // In-memory map is empty — try to recover the last known state from the DB.
  try {
    const lastJob = await prisma.telegramImportJob.findFirst({
      where: { adminId },
      orderBy: { updatedAt: 'desc' },
    });

    if (lastJob) {
      let logs: string[] = [];
      if (lastJob.logs) {
        try { logs = typeof lastJob.logs === 'string' ? JSON.parse(lastJob.logs as string) : (lastJob.logs as string[]); } catch (_) {}
      }

      // Map DB status (uppercase) → in-memory status (lowercase)
      const dbStatusMap: Record<string, ImportProgress['status']> = {
        RUNNING: 'running',
        COMPLETED: 'completed',
        STOPPED: 'stopped',
        FAILED: 'failed',
      };
      const status: ImportProgress['status'] = dbStatusMap[lastJob.status] ?? 'idle';

      // Restore into memory so subsequent polls are instant
      importProgressMap[adminId] = {
        status,
        progress: lastJob.progress,
        total: lastJob.total,
        message: lastJob.message ?? '',
        logs,
      };

      return importProgressMap[adminId];
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


/**
 * Requests the active background import worker to stop.
 */
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
export async function startImport(
  adminId: string,
  sourceChat: string,
  targetBot: string,
  delayMs: number = 2000,
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

  const client = await getConnectedClient(adminId);
  if (!client) {
    throw new Error('Telegram client is not authenticated. Please log in first.');
  }

  let job;
  if (resumeJobId) {
    job = await prisma.telegramImportJob.findUnique({
      where: { id: resumeJobId },
    });
    if (!job) {
      throw new Error(`Job to resume not found: ${resumeJobId}`);
    }
    // Update status to RUNNING in database
    await prisma.telegramImportJob.update({
      where: { id: resumeJobId },
      data: {
        status: 'RUNNING',
        message: 'Resuming import background worker...',
        updatedAt: new Date(),
      },
    });
  } else {
    // Create database record
    job = await prisma.telegramImportJob.create({
      data: {
        adminId,
        sourceChat,
        targetBot,
        status: 'RUNNING',
        progress: 0,
        total: 0,
        limitCount,
        skipExisting,
        startMessageId: startMessageId ?? null,
        endMessageId: endMessageId ?? null,
        message: 'Initializing import background worker...',
        logs: JSON.stringify([`[${new Date().toLocaleTimeString()}] Initializing import background worker...`]),
      },
    });
  }

  importProgressMap[adminId] = {
    status: 'running',
    progress: resumeJobId ? job.progress : 0,
    total: resumeJobId ? job.total : 0,
    message: resumeJobId ? 'Resuming import background worker...' : 'Initializing import background worker...',
    logs: resumeJobId
      ? [`[${new Date().toLocaleTimeString()}] Resuming import from video index #${job.progress + 1}...`]
      : [`[${new Date().toLocaleTimeString()}] Initializing import background worker...`],
  };

  activeImportControllers[adminId] = { stop: false };
  const controller = activeImportControllers[adminId];

  // Run the import worker in the background
  (async () => {
    try {
      await updateJobProgress(job.id, adminId, { message: 'Resolving Telegram chat handles...' }, 'Resolving chat handles...');
      
      const sourceEntity = await resolveEntity(client, sourceChat, adminId);
      const safeTargetBot = targetBot.replace(/^@+/, '@');
      const targetEntity = await client.getEntity(safeTargetBot);

      const botHandle = safeTargetBot.replace(/^@/, '');
      const targetBotDb = await prisma.bot.findUnique({ where: { name: botHandle } });
      const targetBotDbId = targetBotDb?.id;

      await updateJobProgress(job.id, adminId, { message: 'Fetching video list from source chat...' }, 'Scanning for videos...');

      // Determine skip progress
      let lastMsgId: number | undefined;
      const skipExistingCheck = resumeJobId ? job.skipExisting : skipExisting;
      const jobLimit = resumeJobId ? job.limitCount : limitCount;

      if (skipExistingCheck) {
        const key = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
        const setting = await prisma.setting.findUnique({ where: { key } });
        if (setting && setting.value) {
          lastMsgId = parseInt(setting.value, 10);
        }
      }

      const videoIds: number[] = [];
      
      // Resolve range message IDs from job (supports resume) or fresh params
      const jobStartId = resumeJobId ? (job.startMessageId ?? undefined) : startMessageId;
      const jobEndId   = resumeJobId ? (job.endMessageId   ?? undefined) : endMessageId;

      // Build iterMessages options:
      //  - minId = jobStartId - 1  so that message jobStartId itself IS included
      //  - maxId = jobEndId        so that only messages up to jobEndId are fetched
      //  - If skipExisting checkpoint is set AND no explicit start, apply lastMsgId as minId
      const effectiveMinId = jobStartId
        ? jobStartId - 1
        : (lastMsgId ?? undefined);

      // Use iterMessages with video filter. This is extremely fast and avoids downloading non-video messages.
      // Emit live in-memory scan progress every 100 videos so the frontend shows a running count
      // instead of staying at 0 for the entire (potentially long) scan phase.
      let scanTick = 0;
      for await (const message of client.iterMessages(sourceEntity, {
        filter: new Api.InputMessagesFilterVideo(),
        ...(effectiveMinId ? { minId: effectiveMinId } : {}),
        ...(jobEndId       ? { maxId: jobEndId }        : {}),
      })) {
        if (controller.stop) break;
        videoIds.push((message as Api.Message).id);
        scanTick++;
        // Update in-memory only (no DB) every 100 videos during scan
        if (scanTick % 100 === 0) {
          const inMemory = importProgressMap[adminId];
          if (inMemory) {
            inMemory.message = `Scanning source chat... ${scanTick} videos found so far`;
            inMemory.progress = 0;
            inMemory.total = scanTick; // tentative total so frontend can show the number
          }
        }
      }

      if (controller.stop) {
        await updateJobProgress(job.id, adminId, { status: 'STOPPED', message: 'Import stopped during scan.' }, 'Import stopped by admin during scan.');
        return;
      }

      // Reverse to forward oldest first (preserves chronological order)
      videoIds.reverse();

      let totalVideos = videoIds.length;
      if (jobLimit && totalVideos > jobLimit) {
        videoIds.splice(jobLimit); // Only keep the oldest limit videos
        totalVideos = jobLimit;
      }

      if (totalVideos === 0) {
        await updateJobProgress(job.id, adminId, { status: 'COMPLETED', total: 0, progress: 0, message: 'No new videos found.' }, 'Completed: No new video files found in source.');
        return;
      }

      // On resume, always start the processing loop from job.progress so we skip
      // already-transferred videos. skipExisting only controls duplicate detection
      // within the scan, not the loop counter.
      const startIndex = resumeJobId ? job.progress : 0;

      await updateJobProgress(
        job.id,
        adminId,
        { 
          total: totalVideos, 
          progress: startIndex, 
          message: resumeJobId 
            ? `Discovered ${totalVideos} videos. Resuming from #${startIndex + 1}...` 
            : `Discovered ${totalVideos} videos. Forwarding...` 
        },
        resumeJobId
          ? `Discovered ${totalVideos} videos. Resuming from index #${startIndex + 1}.`
          : `Discovered ${totalVideos} videos${lastMsgId ? ` (starting after message ID ${lastMsgId})` : ''}. Starting forwards.`
      );

      // Stream Piping dynamically scales chunk size for files > 2GB.
      // 200MB limit enabled to prevent Render server from crashing out of memory.
      const DISK_FALLBACK_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

      // Start with batch forwarding enabled for unrestricted channels — up to 10x faster.
      // The error handler below switches this to false the moment Telegram rejects with FORWARDS_RESTRICTED.
      let useBatchForward = true;
      const batchSize = 10; // Batch size of up to 10 videos

      // Sliding window of cached message details to eliminate FILE_REFERENCE_EXPIRED
      let loadedMessages: Api.Message[] = [];
      let loadedStartIdx = -1;

      // ── Restricted-video parallel pipe queue ────────────────────────────────
      // Instead of processing restricted videos one-by-one inside the main loop,
      // we collect them into a buffer and flush in parallel batches of STREAM_PIPE_CONCURRENCY.
      interface PendingPipe {
        msg: Api.Message;
        index: number; // original loop index (for progress reporting)
      }
      let pendingPipes: PendingPipe[] = [];

      /**
       * Flush the current pendingPipes buffer: pipe all videos in parallel,
       * then report progress for each one that succeeded.
       * Returns the number of videos successfully transferred.
       */
      const flushPipes = async (isLastFlush: boolean = false): Promise<number> => {
        if (pendingPipes.length === 0) return 0;
        const batch = pendingPipes.splice(0);
        let successCount = 0;

        // ── Per-video progress helper ─────────────────────────────────────────
        // Reports progress immediately when each individual video finishes,
        // so the progress bar fills smoothly instead of jumping at batch end.
        const reportProgress = async (vidIdx: number, vidMsg: Api.Message) => {
          successCount++;
          const isDbCheckpoint = isLastFlush || (vidIdx + 1) % 10 === 0 || vidIdx + 1 === totalVideos;

          if (isDbCheckpoint) {
            const progressKey = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
            await prisma.setting.upsert({
              where: { key: progressKey },
              update: { value: String(vidMsg.id) },
              create: { key: progressKey, value: String(vidMsg.id) },
            }).catch((err) => console.error('Failed to update last message ID setting:', err));
          }

          await updateJobProgress(
            job.id, adminId,
            { progress: vidIdx + 1, message: `Transferred video ${vidIdx + 1} of ${totalVideos}...` },
            `[Stream Pipe] Transferred video ${vidIdx + 1}/${totalVideos} (Message ID: ${vidMsg.id})`,
            isDbCheckpoint
          );
        };

        // One upload mutex shared across all parallel pipes in this batch.
        // Downloads run in parallel; uploads are serialized to protect the main sender.
        const uploadMutex = new AsyncMutex();

        // Per-video timeout: if a single pipe + fallback takes longer than 5 minutes,
        // force-reject it so the rest of the batch isn't held hostage.
        const PIPE_VIDEO_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
        const withTimeout = (p: Promise<void>, label: string): Promise<void> =>
          Promise.race([
            p,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error(`${label} timed out after 5 minutes`)), PIPE_VIDEO_TIMEOUT_MS)
            ),
          ]);

        await Promise.allSettled(
          batch.map(({ msg, index }) =>
            withTimeout(
              streamPipeVideo(client, sourceEntity, targetEntity, msg, uploadMutex)
                .then(async () => {
                  // ✅ Report progress immediately on success
                  await reportProgress(index, msg);
                })
                .catch(async (pipeErr: any) => {
                  await updateJobProgress(
                    job.id, adminId, {},
                    `Stream pipe failed for video #${index + 1} (${pipeErr?.message ?? pipeErr}). Falling back to disk method...`
                  );
                  const doc = (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document)
                    ? msg.media.document : null;
                  const docSize = Number(doc?.size ?? 0);
                  if (docSize > DISK_FALLBACK_MAX_BYTES) {
                    await updateJobProgress(
                      job.id, adminId, { progress: index + 1 },
                      `Skipped video ${index + 1}/${totalVideos}: too large for disk fallback (${Math.round(docSize / 1024 / 1024)} MB > 200 MB).`
                    );
                    return;
                  }
                  await diskDownloadAndUpload(client, sourceEntity, targetEntity, msg, job.id, adminId, index, totalVideos);
                  // ✅ Report progress immediately after disk fallback completes too
                  await reportProgress(index, msg);
                }),
              `Video #${index + 1}`
            ).catch(async (timeoutErr: any) => {
              await updateJobProgress(
                job.id, adminId, { progress: index + 1 },
                `Video #${index + 1} skipped: ${timeoutErr.message}`
              );
            })
          )
        );

        return successCount;
      };

      for (let i = startIndex; i < totalVideos; i++) {
        if (controller.stop) {
          // Bug 9 Fix: flush any restricted videos that were buffered in pendingPipes
          // but not yet piped. Without this, 1–3 videos are silently dropped whenever
          // the user stops mid-batch before the buffer fills to STREAM_PIPE_CONCURRENCY.
          if (pendingPipes.length > 0) {
            await updateJobProgress(
              job.id, adminId,
              { message: `Flushing ${pendingPipes.length} buffered video(s) before stopping...` },
              `Stop requested — flushing ${pendingPipes.length} pending restricted video(s) before exit.`,
              false
            );
            await flushPipes(true);
          }
          await updateJobProgress(
            job.id,
            adminId,
            { status: 'STOPPED', message: `Import stopped. Processed ${i} of ${totalVideos} videos.` },
            `Import stopped by admin. Forwarded ${i}/${totalVideos}.`
          );
          return;
        }

        // Ensure the current index is within our loaded messages window
        if (i < loadedStartIdx || i >= loadedStartIdx + loadedMessages.length) {
          const chunkIds = videoIds.slice(i, Math.min(i + 50, totalVideos));
          try {
            const fetched = await client.getMessages(sourceEntity, { ids: chunkIds });
            loadedMessages = (fetched || []).filter(
              (m) => m && !(m instanceof Api.MessageEmpty)
            ) as Api.Message[];
            loadedStartIdx = i;
          } catch (fetchErr: any) {
            console.error(`Failed to fetch message details for batch starting at index ${i}:`, fetchErr);
            await new Promise((resolve) => setTimeout(resolve, 5000));
            i--; // Retry this index
            continue;
          }
        }

        if (loadedMessages.length === 0) {
          // No messages returned in this window, skip to next chunk
          i = Math.min(i + 50, totalVideos) - 1; // loop increment will do the +1
          continue;
        }

        const localIdx = i - loadedStartIdx;
        if (localIdx >= loadedMessages.length) {
          loadedMessages = [];
          loadedStartIdx = -1;
          i--; // Retry
          continue;
        }

        let processedBatch = false;

        if (useBatchForward && i < totalVideos) {
          const batch = loadedMessages.slice(localIdx, Math.min(localIdx + batchSize, loadedMessages.length));
          
          // ── Deep Duplicate Detection (Batch) ──
          const validBatch = [];
          for (const msg of batch) {
            const doc = (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) ? msg.media.document : null;
            let isDuplicate = false;
            if (doc && targetBotDbId) {
              const fileSize = String(doc.size || 0);
              const durationAttr = doc.attributes?.find(a => a instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo;
              const duration = durationAttr ? durationAttr.duration : 0;
              const existing = await prisma.videos.findFirst({
                where: { botId: targetBotDbId, fileSize, duration }
              });
              if (existing) {
                isDuplicate = true;
                await updateJobProgress(job.id, adminId, {}, `[Duplicate] Skipped batch video (Size: ${fileSize}, Duration: ${duration}s) - Already in target bot database.`);
              }
            }
            if (!isDuplicate) validBatch.push(msg);
          }

          if (validBatch.length === 0 && batch.length > 0) {
             // All videos in this batch were duplicates
             i += batch.length - 1;
             processedBatch = true;
             continue;
          }

          const batchIds = validBatch.map((v) => v.id);

          if (validBatch.length > 0) {
            const hasRestricted = validBatch.some((v: any) => v.noforwards);

            if (!hasRestricted) {
              try {
                await client.forwardMessages(targetEntity, {
                  messages: batchIds,
                  fromPeer: sourceEntity,
                });

                // Batch forward succeeded!
                const nextProgress = i + batch.length;
                
                // Update last message ID setting
                const highestBatchMsg = batch[batch.length - 1];
                const isDbCheckpoint = nextProgress % 10 === 0 || nextProgress === totalVideos;

                if (isDbCheckpoint) {
                  const progressKey = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
                  await prisma.setting.upsert({
                    where: { key: progressKey },
                    update: { value: String(highestBatchMsg.id) },
                    create: { key: progressKey, value: String(highestBatchMsg.id) },
                  }).catch((err) => console.error('Failed to update last message ID setting:', err));
                }

                await updateJobProgress(
                  job.id,
                  adminId,
                  { progress: nextProgress, message: `Successfully transferred videos ${i + 1} to ${nextProgress} of ${totalVideos}...` },
                  `Transferred batch of ${batch.length} videos (${i + 1} to ${nextProgress})`,
                  isDbCheckpoint
                );

                i += batch.length - 1; // Fast-forward loop counter
                processedBatch = true;

                // Delay between batches: honour the per-video delay by scaling it to the batch size.
                // e.g. 5 s delay × 10 videos = 50 s wait, matching the intent of the setting.
                if (i < totalVideos - 1 && !controller.stop) {
                  await new Promise((resolve) => setTimeout(resolve, delayMs * batch.length));
                }

              } catch (fwdErr: any) {
                const fwdMsg = fwdErr.message || fwdErr.errorMessage || '';
                if (
                  fwdMsg.includes('CHAT_FORWARDS_RESTRICTED') ||
                  fwdMsg.includes('FORWARDS_RESTRICTED') ||
                  fwdMsg.includes('noforwards')
                ) {
                  useBatchForward = false;
                  await updateJobProgress(
                    job.id,
                    adminId,
                    {},
                    'Batch forward restricted. Switching to one-by-one download fallback mode...'
                  );
                  // Let it fall through to one-by-one logic
                } else if (fwdMsg.includes('FLOOD_WAIT') || fwdMsg.includes('FLOOD') || fwdErr.errorMessage?.includes('FLOOD')) {
                  const match = fwdMsg.match(/(\d+)/);
                  const waitSeconds = match ? parseInt(match[1], 10) : 30;

                  await updateJobProgress(
                    job.id,
                    adminId,
                    { message: `Rate limited. Pausing for ${waitSeconds} seconds...` },
                    `Rate limited during batch forward. Auto-throttling: Waiting ${waitSeconds}s before retrying batch...`
                  );

                  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
                  i--; // Retry this index
                  processedBatch = true;
                  continue;
                } else {
                  await updateJobProgress(
                    job.id,
                    adminId,
                    {},
                    `Batch forward failed: ${fwdErr.message || 'unknown error'}. Retrying individually...`
                  );
                }
              }
            }
          }
        }

        if (processedBatch) continue;

        const msg = loadedMessages[localIdx];

        // ── Deep Duplicate Detection (Single/Restricted) ──
        const doc = (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) ? msg.media.document : null;
        let isDuplicate = false;
        if (doc && targetBotDbId) {
          const fileSize = String(doc.size || 0);
          const durationAttr = doc.attributes?.find(a => a instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo;
          const duration = durationAttr ? durationAttr.duration : 0;
          const existing = await prisma.videos.findFirst({
            where: { botId: targetBotDbId, fileSize, duration }
          });
          if (existing) {
            isDuplicate = true;
            await updateJobProgress(job.id, adminId, { progress: i + 1 }, `[Duplicate] Skipped video (Size: ${fileSize}, Duration: ${duration}s) - Already in DB.`);
          }
        }
        
        if (isDuplicate) continue;

        try {
          let forwarded = false;

          // Pre-check the noforwards flag on the message itself.
          // If set, skip the forward API call entirely and go straight to stream pipe.
          const isForwardRestricted = !!(msg as any).noforwards;

          if (!isForwardRestricted) {
            // Attempt standard forward first (fast path for unrestricted channels)
            try {
              await client.forwardMessages(targetEntity, {
                messages: [msg.id],
                fromPeer: sourceEntity,
              });
              forwarded = true;
            } catch (fwdErr: any) {
              const fwdMsg = fwdErr.message || fwdErr.errorMessage || '';
              if (
                fwdMsg.includes('CHAT_FORWARDS_RESTRICTED') ||
                fwdMsg.includes('FORWARDS_RESTRICTED') ||
                fwdMsg.includes('noforwards')
              ) {
                // Fall through to stream pipe below
              } else {
                throw fwdErr; // re-throw unrelated errors
              }
            }
          }

          if (forwarded) {
            // ── Unrestricted forward succeeded — report progress immediately ──────
            const isDbCheckpoint = (i + 1) % 10 === 0 || i + 1 === totalVideos;

            if (isDbCheckpoint) {
              const progressKey = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
              await prisma.setting.upsert({
                where: { key: progressKey },
                update: { value: String(msg.id) },
                create: { key: progressKey, value: String(msg.id) },
              }).catch((err) => console.error('Failed to update last message ID setting:', err));
            }

            await updateJobProgress(
              job.id,
              adminId,
              { progress: i + 1, message: `Successfully transferred video ${i + 1} of ${totalVideos}...` },
              `Transferred video ${i + 1}/${totalVideos} (Message ID: ${msg.id})`,
              isDbCheckpoint
            );
          } else {
            // ── Restricted video — queue into the parallel stream-pipe buffer ────
            pendingPipes.push({ msg, index: i });

            const isLastVideo = i + 1 === totalVideos;
            const bufferFull = pendingPipes.length >= STREAM_PIPE_CONCURRENCY;

            if (bufferFull || isLastVideo) {
              await updateJobProgress(
                job.id, adminId,
                { message: `Stream-piping batch of ${pendingPipes.length} restricted video(s)...` },
                `Launching parallel stream pipe: ${pendingPipes.length} video(s) (indices ${pendingPipes[0].index + 1}–${pendingPipes[pendingPipes.length - 1].index + 1})`,
                false
              );
              await flushPipes(isLastVideo);
            }
          }
        } catch (forwardErr: any) {
          console.error(`Failed to transfer message ID ${msg.id}:`, forwardErr);
          
          // Auto-throttle & flood wait resilience
          const errMsg = forwardErr.message || '';
          if (errMsg.includes('FLOOD_WAIT') || errMsg.includes('FLOOD') || forwardErr.errorMessage?.includes('FLOOD')) {
            const match = errMsg.match(/(\d+)/);
            const waitSeconds = match ? parseInt(match[1], 10) : 30;
            
            await updateJobProgress(
              job.id,
              adminId,
              { message: `Rate limited. Pausing for ${waitSeconds} seconds...` },
              `Rate limited by Telegram. Auto-throttling: Waiting ${waitSeconds}s before retrying video #${i + 1}...`
            );
            
            await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
            i--; // Decrement to retry this video
            continue;
          }

          // Otherwise log error and continue
          await updateJobProgress(
            job.id,
            adminId,
            { progress: i + 1 },
            `Error transferring video ${i + 1}: ${forwardErr.message || 'Unknown error'}`
          );
        }

        // Delay between forwarding each video to prevent Telegram rate limit bans
        if (i < totalVideos - 1 && !controller.stop) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      await updateJobProgress(
        job.id,
        adminId,
        { status: 'COMPLETED', message: `Completed! Successfully processed all ${totalVideos} videos.` },
        `Completed! Processed all ${totalVideos} videos successfully.`
      );
    } catch (err: any) {
      console.error('Telegram import worker encountered an error:', err);
      await updateJobProgress(
        job.id,
        adminId,
        { status: 'FAILED', message: `Import failed: ${err.message}`, error: err.message },
        `Critical Job Failure: ${err.message}`
      );
    } finally {
      delete activeImportControllers[adminId];
      // Keep the final status readable for 5 minutes so the frontend can poll it,
      // then clear the entry from memory entirely to prevent accumulation.
      setTimeout(() => { delete importProgressMap[adminId]; }, 5 * 60 * 1000);
    }
  })();

  return importProgressMap[adminId];
}

/**
 * Helper to update both DB and in-memory progress.
 */
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
  dbWrite: boolean = true  // set false for high-frequency progress ticks to skip the DB round-trip
) {
  const inMemory = importProgressMap[adminId] || {
    status: 'idle',
    progress: 0,
    total: 0,
    message: '',
    logs: [],
  };

  if (updates.status) {
    inMemory.status = updates.status.toLowerCase() as any;
  }
  if (updates.progress !== undefined) inMemory.progress = updates.progress;
  if (updates.total !== undefined) inMemory.total = updates.total;
  if (updates.message !== undefined) inMemory.message = updates.message;
  if (updates.error !== undefined) inMemory.error = updates.error;

  if (newLog) {
    if (!inMemory.logs) inMemory.logs = [];
    inMemory.logs.push(`[${new Date().toLocaleTimeString()}] ${newLog}`);
    // Cap in-memory logs to prevent unbounded RAM growth on large imports
    const MAX_LOG_LINES = 500;
    if (inMemory.logs.length > MAX_LOG_LINES) {
      inMemory.logs = inMemory.logs.slice(-MAX_LOG_LINES);
    }
  }

  importProgressMap[adminId] = inMemory;

  // Skip DB write for pure in-flight progress ticks (called with dbWrite=false).
  // Status-change calls (STOPPED / COMPLETED / FAILED) always use the default dbWrite=true.
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

/**
 * Stream Pipe: relay a restricted video from the source entity to the target entity
 * without touching the disk. Each 512 KB chunk is downloaded via upload.GetFile and
 * immediately forwarded via upload.SaveBigFilePart, keeping peak RAM at ~512 KB.
 *
 * Telegram reassembles all uploaded parts server-side and delivers the final file
 * when we call sendFile with the resulting InputFileBig reference.
 */
async function streamPipeVideo(
  client: TelegramClient,
  sourceEntity: any,
  targetEntity: any,
  msg: Api.Message,
  /**
   * Shared upload mutex — serializes SaveBigFilePart calls across all parallel
   * pipe loops so the main MTProto sender never has >1 upload in flight.
   * Downloads remain fully parallel (each video uses its own borrowed DC sender).
   */
  uploadMutex?: AsyncMutex
): Promise<void> {
  let doc = (
    msg.media instanceof Api.MessageMediaDocument &&
    msg.media.document instanceof Api.Document
  )
    ? msg.media.document
    : null;

  if (!doc) throw new Error(`Message ${msg.id} has no document`);

  const totalBytes = Number(doc.size);
  // Dynamic chunk sizing for massive files > 1.95 GB to avoid hitting the 3999 parts limit
  let chunkSize = DEFAULT_STREAM_CHUNK_SIZE;
  if (totalBytes > 1.95 * 1024 * 1024 * 1024) {
    chunkSize = 1024 * 1024; // 1MB
  }
  if (totalBytes > 3.9 * 1024 * 1024 * 1024) {
    chunkSize = 2 * 1024 * 1024; // 2MB
  }

  const totalParts = Math.ceil(totalBytes / chunkSize);
  // Random 64-bit file ID for the upload session (Telegram requires this).
  // Cast to `any` to bridge native bigint vs GramJS's BigInteger type.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — GramJS BigInteger vs native bigint
  const fileId: any = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

  // Build the input location needed by GetFile
  let inputLocation = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: '',
  });

  // ── Connect to the file's DC (with retry) ────────────────────────────────
  const SENDER_MAX_RETRIES = 3;
  let sender: any;
  for (let senderAttempt = 0; senderAttempt <= SENDER_MAX_RETRIES; senderAttempt++) {
    try {
      sender = await (client as any)._borrowExportedSender(doc.dcId);
      break; // connected
    } catch (senderErr: any) {
      const isConnectErr =
        senderErr?.message?.includes('Not connected') ||
        senderErr?.message?.includes('disconnected') ||
        senderErr?.message?.includes('ECONNRESET') ||
        senderErr?.message?.includes('ETIMEDOUT');
      if (isConnectErr && senderAttempt < SENDER_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 3000 * (senderAttempt + 1))); // 3s, 6s, 9s
        continue;
      }
      throw senderErr; // non-connect error or retries exhausted
    }
  }

  const GET_FILE_MAX_RETRIES = 3;
  const GET_FILE_RETRY_BASE_MS = 2000;

  // Helper to fetch a chunk with Auto-Refresh for FILE_REFERENCE_EXPIRED
  const fetchChunk = async (partIndex: number): Promise<Buffer> => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const offset: any = BigInt(partIndex) * BigInt(chunkSize);
    const GET_FILE_CHUNK_TIMEOUT_MS = 30_000;

    for (let attempt = 0; attempt <= GET_FILE_MAX_RETRIES; attempt++) {
      try {
        const chunkPromise = sender.send(
          new Api.upload.GetFile({
            location: inputLocation,
            offset,
            limit: chunkSize,
            precise: true,
          })
        );
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('GetFile chunk timeout after 30s')), GET_FILE_CHUNK_TIMEOUT_MS)
        );
        const result = await Promise.race([chunkPromise, timeoutPromise]) as any;
        return result.bytes;
      } catch (getFileErr: any) {
        const errMsg = getFileErr?.message || '';
        
        // ── Auto-Refresh FILE_REFERENCE_EXPIRED ──
        if (errMsg.includes('FILE_REFERENCE_EXPIRED') || errMsg.includes('FILE_REFERENCE_EMPTY')) {
          console.log(`[StreamPipe] File reference expired at part ${partIndex}. Refreshing from source...`);
          try {
            const refreshed = await client.getMessages(sourceEntity, { ids: [msg.id] });
            if (refreshed && refreshed[0]) {
              const freshMsg = refreshed[0];
              const freshDoc = (freshMsg.media instanceof Api.MessageMediaDocument && freshMsg.media.document instanceof Api.Document)
                ? freshMsg.media.document : null;
              if (freshDoc) {
                doc = freshDoc;
                inputLocation = new Api.InputDocumentFileLocation({
                  id: doc.id,
                  accessHash: doc.accessHash,
                  fileReference: doc.fileReference,
                  thumbSize: '',
                });
                continue; // Retry fetch with fresh file reference
              }
            }
          } catch (refreshErr) {
            console.error('Failed to refresh file reference', refreshErr);
          }
          throw new Error('Failed to refresh expired file reference during stream pipe.');
        }

        const isRetryable =
          errMsg.includes('-503') ||
          getFileErr?.errorCode === -503 ||
          errMsg.includes('Timeout') ||
          errMsg.includes('timeout') ||
          errMsg.includes('Not connected') ||
          errMsg.includes('disconnected') ||
          errMsg.includes('ECONNRESET');
          
        if (isRetryable && attempt < GET_FILE_MAX_RETRIES) {
          try { if (doc) { sender = await (client as any)._borrowExportedSender(doc.dcId); } } catch (_) {}
          await new Promise((r) => setTimeout(r, GET_FILE_RETRY_BASE_MS * (attempt + 1)));
          continue;
        }
        throw getFileErr;
      }
    }
    throw new Error(`Failed to fetch part ${partIndex} after retries`);
  };

  // ── Asynchronous Pipelining (Read-Ahead Buffer) ──
  // We start downloading the next chunk while the current one is uploading.
  let nextChunkPromise = totalParts > 0 ? fetchChunk(0) : Promise.resolve(Buffer.alloc(0));

  for (let part = 0; part < totalParts; part++) {
    const chunkBytes = await nextChunkPromise;
    if (!chunkBytes || chunkBytes.length === 0) {
      throw new Error(`Empty chunk received at part ${part} for message ${msg.id}`);
    }

    // Read-ahead: Fetch next chunk immediately while uploading this one
    if (part + 1 < totalParts) {
      nextChunkPromise = fetchChunk(part + 1);
    }

    // Upload this chunk via the main client
    const doUpload = () =>
      client.invoke(
        new Api.upload.SaveBigFilePart({
          fileId,
          filePart: part,
          fileTotalParts: totalParts,
          bytes: chunkBytes,
        })
      );

    const uploadOk = uploadMutex ? await uploadMutex.lock(doUpload) : await doUpload();

    if (!uploadOk) {
      throw new Error(`SaveBigFilePart returned false at part ${part} for message ${msg.id}`);
    }
  }

  // All parts uploaded — tell Telegram to assemble and deliver the file
  const attrs = doc.attributes ?? [];
  const filenameAttr = attrs.find((a) => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined;
  const filename = filenameAttr?.fileName || `video_${msg.id}.mp4`;

  const inputFileBig = new Api.InputFileBig({
    id: fileId,
    parts: totalParts,
    name: filename,
  });

  // ── Download original thumbnail to avoid black preview on re-uploaded videos ──
  // Stream pipe re-uploads raw bytes without the thumbnail, so we fetch it
  // from Telegram and pass it explicitly to sendFile.
  let thumbBuffer: Buffer | undefined;
  try {
    const photoThumbs = (doc.thumbs || []).filter(
      (t: any) => t instanceof Api.PhotoSize || t instanceof Api.PhotoCachedSize
    ) as (Api.PhotoSize | Api.PhotoCachedSize)[];
    if (photoThumbs.length > 0) {
      // Pick the largest available thumbnail
      const bestThumb = photoThumbs.reduce((best: any, curr: any) =>
        ((curr.w || 0) * (curr.h || 0)) > ((best.w || 0) * (best.h || 0)) ? curr : best
      );
      const thumbLocation = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: bestThumb.type,
      });
      const thumbResult = await client.invoke(
        new Api.upload.GetFile({
          location: thumbLocation,
          // @ts-ignore — BigInt vs GramJS BigInteger
          offset: BigInt(0) as any,
          limit: 512 * 1024,
          precise: false,
        })
      ) as any;
      if (thumbResult?.bytes?.length > 0) {
        thumbBuffer = Buffer.from(thumbResult.bytes);
      }
    }
  } catch (_thumbErr) {
    // Thumbnail is optional — proceed without it
  }

  await client.sendFile(targetEntity, {
    file: inputFileBig,
    caption: msg.message || '',
    forceDocument: false,
    thumb: thumbBuffer,
    attributes: filenameAttr ? attrs : [...attrs, new Api.DocumentAttributeFilename({ fileName: filename })],
    workers: 1, // Reduced workers for final assembly/sending to prevent OOM on Render
  });
}

/**
 * Disk-based fallback: download the full video to a temp file, then upload it.
 * Only used when streamPipeVideo() throws — kept for maximum resilience.
 */
async function diskDownloadAndUpload(
  client: TelegramClient,
  sourceEntity: any,
  targetEntity: any,
  msg: Api.Message,
  jobId: string,
  adminId: string,
  index: number,
  totalVideos: number
): Promise<void> {
  const origDoc = (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document)
    ? msg.media.document : null;
  const origAttrs = origDoc?.attributes ?? [];
  const filenameAttr = origAttrs.find((a) => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined;
  const filename = filenameAttr?.fileName || `video_${msg.id}.mp4`;
  const tmpPath = path.join(os.tmpdir(), `tg_import_fallback_${adminId}_${msg.id}_${Date.now()}${path.extname(filename) || '.mp4'}`);

  let currentMsg = msg;
  try {
    try {
      await client.downloadMedia(currentMsg, { outputFile: tmpPath });
    } catch (dlErr: any) {
      const errMsg = dlErr?.message || dlErr?.errorMessage || '';
      if (errMsg.includes('FILE_REFERENCE_EXPIRED')) {
        const refreshed = await client.getMessages(sourceEntity, { ids: [msg.id] });
        if (refreshed && refreshed[0]) {
          currentMsg = refreshed[0];
          await client.downloadMedia(currentMsg, { outputFile: tmpPath });
        } else {
          throw dlErr;
        }
      } else {
        throw dlErr;
      }
    }

    const fileSize = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
    if (fileSize === 0) {
      await updateJobProgress(
        jobId, adminId, { progress: index + 1 },
        `[Disk Fallback] Skipped video ${index + 1}/${totalVideos}: download wrote empty file (Message ID: ${msg.id}).`
      );
      return;
    }

    const freshDoc = (currentMsg.media instanceof Api.MessageMediaDocument && currentMsg.media.document instanceof Api.Document)
      ? currentMsg.media.document : null;
    const freshAttrs = freshDoc?.attributes ?? [];
    const freshFilenameAttr = freshAttrs.find((a) => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined;
    const freshFilename = freshFilenameAttr?.fileName || `video_${currentMsg.id}.mp4`;
    const attributes = freshFilenameAttr
      ? freshAttrs
      : [...freshAttrs, new Api.DocumentAttributeFilename({ fileName: freshFilename })];

    // ── Download original thumbnail (disk fallback path) ──────────────────────
    let diskThumbBuffer: Buffer | undefined;
    try {
      const photoThumbs = (freshDoc?.thumbs || []).filter(
        (t: any) => t instanceof Api.PhotoSize || t instanceof Api.PhotoCachedSize
      ) as (Api.PhotoSize | Api.PhotoCachedSize)[];
      if (photoThumbs.length > 0 && freshDoc) {
        const bestThumb = photoThumbs.reduce((best: any, curr: any) =>
          ((curr.w || 0) * (curr.h || 0)) > ((best.w || 0) * (best.h || 0)) ? curr : best
        );
        const thumbLocation = new Api.InputDocumentFileLocation({
          id: freshDoc.id,
          accessHash: freshDoc.accessHash,
          fileReference: freshDoc.fileReference,
          thumbSize: bestThumb.type,
        });
        const thumbResult = await client.invoke(
          new Api.upload.GetFile({
            location: thumbLocation,
            // @ts-ignore — BigInt vs GramJS BigInteger
            offset: BigInt(0) as any,
            limit: 512 * 1024,
            precise: false,
          })
        ) as any;
        if (thumbResult?.bytes?.length > 0) {
          diskThumbBuffer = Buffer.from(thumbResult.bytes);
        }
      }
    } catch (_thumbErr) {
      // Thumbnail is optional
    }

    await client.sendFile(targetEntity, {
      file: tmpPath,
      caption: currentMsg.message || '',
      forceDocument: false,
      thumb: diskThumbBuffer,
      attributes,
      workers: 4,
    });
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

/**
 * Counts the number of video messages in a given chat/channel.
 */
export async function countVideos(adminId: string, sourceChat: string): Promise<number> {
  const client = await getConnectedClient(adminId);
  if (!client) {
    throw new Error('Telegram client is not authenticated. Please log in first.');
  }

  const sourceEntity = await resolveEntity(client, sourceChat, adminId);

  // Call messages.Search with video filter and limit: 1 to get the exact count instantly.
  const result = await client.invoke(
    new Api.messages.Search({
      peer: sourceEntity,
      q: '',
      filter: new Api.InputMessagesFilterVideo(),
      minDate: 0,
      maxDate: 0,
      offsetId: 0,
      addOffset: 0,
      limit: 1,
      maxId: 0,
      minId: 0,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — GramJS BigInteger vs native bigint
      hash: BigInt(0),
    })
  ) as any;

  return result.count ?? 0;
}

/**
 * Returns checkpoint info for a given source→target pair:
 *   - lastMsgId: the Telegram message ID we last processed (stored in Settings)
 *   - importedCount: how many videos the target bot currently has in the DB
 */
export async function getCheckpoint(
  sourceChat: string,
  targetBot: string
): Promise<{ lastMsgId: number | null; importedCount: number }> {
  const key = `telegram_last_msg_id_${sourceChat.replace(/[@+]/g, '')}_${targetBot.replace(/[@+]/g, '')}`;
  const setting = await prisma.setting.findUnique({ where: { key } });
  const lastMsgId = setting?.value ? parseInt(setting.value, 10) : null;

  // Count videos already stored for the target bot (match by bot.name from targetBot handle)
  const botHandle = targetBot.replace(/^@/, '');
  const bot = await prisma.bot.findUnique({ where: { name: botHandle } });
  const importedCount = bot
    ? await prisma.videos.count({ where: { botId: bot.id } })
    : 0;

  return { lastMsgId, importedCount };
}

/**
 * Lists all dialogs (chats, channels, groups) for the authenticated user.
 */
export async function listChats(adminId: string) {
  const client = await getConnectedClient(adminId);
  if (!client) {
    throw new Error('Telegram client is not authenticated. Please log in first.');
  }

  let dialogs = [];
  const now = Date.now();
  if (dialogCache[adminId] && (now - dialogCache[adminId].fetchedAt < DIALOG_CACHE_TTL_MS)) {
    dialogs = dialogCache[adminId].dialogs;
  } else {
    // Limit to 100 to keep response times under control.
    // Accounts with hundreds of chats can take 30+ seconds for larger limits.
    dialogs = await client.getDialogs({ limit: 100 });
    dialogCache[adminId] = { dialogs, fetchedAt: now };
  }
  const chats = dialogs
    .map((d) => {
      const entity = d.entity;
      const isChannel = d.isChannel || false;
      const isGroup = d.isGroup || false;
      let title = '';
      let username = '';
      let id = '';

      if (entity instanceof Api.Chat) {
        title = entity.title || '';
        id = entity.id.toString();
      } else if (entity instanceof Api.Channel) {
        title = entity.title || '';
        username = entity.username || '';
        id = entity.id.toString();
      } else if (entity instanceof Api.User) {
        title = [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || 'User';
        username = entity.username || '';
        id = entity.id.toString();
      }

      return {
        id,
        title,
        username,
        isChannel,
        isGroup,
      };
    })
    .filter((c) => c.title || c.username);

  return chats;
}


