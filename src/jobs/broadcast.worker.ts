import prisma from '../lib/prisma';
import { mainBot } from '../bots/main.bot';
import { getIO } from '../lib/socket';
import { InputFile } from 'grammy';
import type { Server as SocketIOServer } from 'socket.io';
import { canPoll, isQuotaError, tripBreaker } from '../lib/dbCircuitBreaker';

function safeGetIO(): SocketIOServer | null {
  try {
    return getIO();
  } catch {
    return null;
  }
}

// ─── Backoff Config ────────────────────────────────────────────────────────────
const MIN_POLL_MS = 5_000;   // 5s when broadcasts exist
const MAX_POLL_MS = 60_000;  // 60s when idle
let currentPollMs = MIN_POLL_MS;
let pollTimeout: NodeJS.Timeout | null = null;
let stopped = false;
let isProcessing = false;

async function processBroadcast(broadcastId: string) {
  const io = safeGetIO();
  
  // 1. Mark as PROCESSING and fetch users if not done
  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast || broadcast.status === 'COMPLETED') return;

  console.log(`[BroadcastWorker] Processing: ${broadcast.id} (${broadcast.audience})`);

  if (broadcast.status === 'PENDING') {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'PROCESSING' }
    });
  }

  // 2. Identify the audience
  const whereClause: any = { isBanned: false };
  if (broadcast.audience === 'ADMINS') whereClause.role = 'ADMIN';
  else if (broadcast.audience === 'USERS') whereClause.role = 'USER';
  else if (broadcast.audience === 'BANNED') whereClause.isBanned = true;
  else if (broadcast.audience === 'ALL') { delete whereClause.isBanned; }

  // 3. Update totalUsers count if it's 0 (first run)
  let totalUsers = broadcast.totalUsers;
  if (totalUsers === 0) {
    totalUsers = await prisma.user.count({ where: whereClause });
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { totalUsers }
    });
  }

  // To keep it simple and résumable, we fetch users in batches OR skip based on sentCount
  const users = await prisma.user.findMany({
    where: whereClause,
    select: { telegramId: true },
    orderBy: { createdAt: 'asc' },
    skip: broadcast.sentCount + broadcast.failedCount,
    take: 50 // process in small batches
  });

  if (users.length === 0) {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'COMPLETED' }
    });
    io?.emit('broadcast:finished', { id: broadcastId });
    return;
  }

  let localSent = 0;
  let localFailed = 0;

  for (const user of users) {
    try {
      if (broadcast.mediaUrl) {
        if (broadcast.mediaType === 'image') {
          await mainBot.api.sendPhoto(user.telegramId.toString(), broadcast.mediaUrl, { caption: broadcast.message, parse_mode: 'HTML' });
        } else if (broadcast.mediaType === 'video') {
          await mainBot.api.sendVideo(user.telegramId.toString(), broadcast.mediaUrl, { caption: broadcast.message, parse_mode: 'HTML' });
        } else {
          await mainBot.api.sendDocument(user.telegramId.toString(), broadcast.mediaUrl, { caption: broadcast.message, parse_mode: 'HTML' });
        }
      } else {
        await mainBot.api.sendMessage(user.telegramId.toString(), broadcast.message, { parse_mode: 'HTML' });
      }
      localSent++;
      // Rate limiting: 50ms = 20 msg/sec
      await new Promise(r => setTimeout(r, 50));
    } catch (err: any) {
      console.error(`[BroadcastWorker] Failed for ${user.telegramId}:`, err?.message);
      localFailed++;
      
      const code = err?.error_code;
      if (code === 429) {
        const retryAfter = err?.parameters?.retry_after || 5;
        console.warn(`[BroadcastWorker] Rate limited (429). Pausing for ${retryAfter}s.`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
      }
    }
  }

  // Update DB with this batch's results
  const updated = await prisma.broadcast.update({
    where: { id: broadcastId },
    data: {
      sentCount: { increment: localSent },
      failedCount: { increment: localFailed }
    }
  });

  // Emit progress
  io?.emit('broadcast:progress', {
    id: broadcastId,
    sent: updated.sentCount,
    failed: updated.failedCount,
    total: updated.totalUsers,
    percent: Math.round(((updated.sentCount + updated.failedCount) / updated.totalUsers) * 100)
  });
}

// ─── Poll loop using setTimeout chain (supports dynamic backoff) ──────────────
async function pollOnce() {
  if (stopped) return;

  // Circuit breaker check
  if (!canPoll()) {
    schedulePoll(MAX_POLL_MS);
    return;
  }

  if (isProcessing) {
    schedulePoll(MIN_POLL_MS);
    return;
  }

  try {
    // Find one broadcast that needs processing
    const broadcast = await prisma.broadcast.findFirst({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
      orderBy: { createdAt: 'asc' }
    });

    if (!broadcast) {
      // Nothing to do — back off (5s → 10s → 20s → 40s → 60s)
      currentPollMs = Math.min(currentPollMs * 2, MAX_POLL_MS);
      schedulePoll(currentPollMs);
      return;
    }

    // Found work — reset to fast polling
    currentPollMs = MIN_POLL_MS;
    isProcessing = true;
    await processBroadcast(broadcast.id);
  } catch (err) {
    console.error('[BroadcastWorker] Error in poll loop:', err);
    if (isQuotaError(err)) {
      tripBreaker();
      schedulePoll(MAX_POLL_MS);
      return;
    }
    // Generic error — slow down
    currentPollMs = Math.min(currentPollMs * 2, MAX_POLL_MS);
  } finally {
    isProcessing = false;
  }

  schedulePoll(currentPollMs);
}

function schedulePoll(ms: number) {
  if (stopped) return;
  pollTimeout = setTimeout(pollOnce, ms);
}

export const startBroadcastWorker = () => {
  console.log('[BroadcastWorker] Starting worker (backoff + circuit breaker)...');
  stopped = false;
  currentPollMs = MIN_POLL_MS;
  schedulePoll(MIN_POLL_MS);
};

export const stopBroadcastWorker = () => {
  stopped = true;
  if (pollTimeout) clearTimeout(pollTimeout);
  console.log('[BroadcastWorker] Stopped');
};
