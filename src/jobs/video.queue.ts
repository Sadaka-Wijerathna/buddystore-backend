import prisma from '../lib/prisma';
import { categoryBots } from '../bots/category.bot';
import { getIO } from '../lib/socket';
import type { Server as SocketIOServer } from 'socket.io';
import { InlineKeyboard } from 'grammy';
import { mainBot } from '../bots/main.bot';
import { canPoll, isQuotaError, tripBreaker } from '../lib/dbCircuitBreaker';

function safeGetIO(): SocketIOServer | null {
  try {
    return getIO();
  } catch {
    return null;
  }
}

export interface VideoDeliveryJobData {
  orderId: string;
  userId: string;
  userTelegramId: string;
  category: string; // Free-form category slug
  videoCount: number;
}

// Backward-compat alias for the admin controller
export const videoDeliveryQueue = {
  add: async (jobName: string, data: VideoDeliveryJobData, opts?: any) => {
    // ── Duplicate job guard ───────────────────────────────────────────────────
    // Prevent creating a second delivery job while one is already PENDING or
    // PROCESSING for the same order. This stops double-delivery when a failed
    // job resets the order to CONFIRMED and the admin re-triggers delivery,
    // or when two code paths both try to queue the same order simultaneously.
    const existingActiveJob = await prisma.videoDeliveryJob.findFirst({
      where: {
        orderId: data.orderId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      select: { id: true, status: true },
    });

    if (existingActiveJob) {
      console.warn(
        `[Queue] Skipping duplicate job for order ${data.orderId} — ` +
        `an active job already exists (id=${existingActiveJob.id}, status=${existingActiveJob.status})`
      );
      return { id: existingActiveJob.id };
    }
    // ─────────────────────────────────────────────────────────────────────────

    console.log(`[Queue] Adding job to postgres queue for order: ${data.orderId}`);
    await prisma.videoDeliveryJob.create({
      data: {
        orderId: data.orderId,
        userId: data.userId,
        userTelegramId: BigInt(data.userTelegramId),
        category: data.category,
        videoCount: data.videoCount,
        status: 'PENDING',
      }
    });
    return { id: `pg-${Date.now()}` };
  }
};

// ─── Concurrency Control ───────────────────────────────────────────────────────
// Max number of delivery jobs running at the same time.
// Each job sends to a different user, so they don't interfere with each other.
// The global rate limiter in category.bot.ts ensures all combined sends stay under 25/sec.
const MAX_CONCURRENT_JOBS = 3;
let activeJobCount = 0;

// ─── Backoff Config ────────────────────────────────────────────────────────────
const MIN_POLL_MS = 5_000;   // 5s when jobs exist
const MAX_POLL_MS = 60_000;  // 60s when idle
let currentPollMs = MIN_POLL_MS;
let pollTimeout: NodeJS.Timeout | null = null;
let stopped = false;

// ─── Process a single delivery job ────────────────────────────────────────────
async function processJob(jobId: string) {
  const io = safeGetIO();

  const pendingJob = await prisma.videoDeliveryJob.findUnique({ where: { id: jobId } });
  if (!pendingJob) return;

  // Guard: if somehow this job is no longer PROCESSING (e.g. claimed by another
  // worker instance after a restart), bail out to prevent double-delivery.
  if (pendingJob.status !== 'PROCESSING') {
    console.warn(`[Job] Job ${jobId} has status '${pendingJob.status}' — expected PROCESSING. Skipping to prevent duplicate delivery.`);
    return;
  }

  const { orderId, userId, userTelegramId, category, videoCount } = pendingJob;
  console.log(`[Job] Starting video delivery for order ${orderId} (Job ${jobId}) — active: ${activeJobCount}/${MAX_CONCURRENT_JOBS}`);

  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'DELIVERING' },
  });

  io?.to(`order:${orderId}`).emit('order:status', {
    orderId, status: 'DELIVERING', delivered: 0, total: videoCount, percentComplete: 0,
  });

  const bot = categoryBots[category];
  if (!bot) throw new Error(`No bot found for category: ${category}`);

  const sentCount = await bot.sendVideosToUser(
    orderId,
    userId,
    userTelegramId,
    videoCount,
    async (sent, total) => {
      const percent = Math.round((sent / total) * 100);
      
      // OPTIMIZATION: Emit socket every video for smooth UI,
      // but only spam the PostgreSQL DB every 10 videos (or at the very end).
      // This saves hundreds of DB UPDATE queries per order.
      if (sent % 10 === 0 || sent === total) {
        await prisma.videoDeliveryJob.update({ where: { id: jobId }, data: { progress: percent } });
      }

      io?.to(`order:${orderId}`).emit('order:progress', {
        orderId, delivered: sent, total, percentComplete: percent,
      });
    }
  );

  // ── Conditional completion ────────────────────────────────────────────────
  if (sentCount >= videoCount) {
    // ✅ Fully delivered
    await prisma.videoDeliveryJob.update({ where: { id: jobId }, data: { status: 'COMPLETED', progress: 100 } });
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    // Message: Delivery summary (permanent, no keyboard)
    try {
      const order = await prisma.order.findUnique({ where: { id: orderId }, include: { bot: true } });
      const categoryLabel = order?.bot?.name ?? category.replace(/_/g, ' ');

      await mainBot.api.sendMessage(
        userTelegramId.toString(),
        `🎉 *Delivery Complete!*\n\n` +
        `All *${sentCount} video${sentCount !== 1 ? 's' : ''}* from the *${categoryLabel}* collection have been delivered successfully!\n\n` +
        `📦 *Order ID:* \`${orderId}\`\n` +
        `🎬 *Videos Sent:* ${sentCount}/${videoCount}\n` +
        `🔒 *Note:* These videos are for your personal use only. Forwarding is disabled.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error(`[Job] Failed to send delivery summary for order ${orderId}:`, err);
    }

    io?.to(`order:${orderId}`).emit('order:status', {
      orderId, status: 'COMPLETED', delivered: sentCount, total: videoCount, percentComplete: 100,
    });
    console.log(`[Job] Order ${orderId} completed: ${sentCount}/${videoCount} videos sent`);

  } else {
    // ⚠️ Under-delivered — mark this job FAILED, then silently enqueue a new
    // job for the remaining videos so delivery continues without interrupting the user.
    const remaining = videoCount - sentCount;
    const percent = Math.round((sentCount / videoCount) * 100);
    const errorMsg = `Under-delivered: only ${sentCount}/${videoCount} sent. Re-queued ${remaining} remaining.`;

    await prisma.videoDeliveryJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', progress: percent, error: errorMsg },
    });

    // Silently create a new job for the remaining videos (no message to user)
    await prisma.videoDeliveryJob.create({
      data: {
        orderId,
        userId,
        userTelegramId,
        category,
        videoCount: remaining,
        status: 'PENDING',
      },
    });

    // Keep the order in DELIVERING so the user sees continuous progress
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'DELIVERING' },
    });

    io?.to(`order:${orderId}`).emit('order:progress', {
      orderId, delivered: sentCount, total: videoCount, percentComplete: percent,
    });
    console.warn(`[Job] Order ${orderId} UNDER-DELIVERED: ${sentCount}/${videoCount} sent. Re-queued ${remaining} remaining videos (no user notification).`);
  }
}

// ─── Poll loop using setTimeout chain (supports dynamic backoff) ──────────────
async function pollOnce() {
  if (stopped) return;

  // Circuit breaker check — skip this tick entirely
  if (!canPoll()) {
    schedulePoll(MAX_POLL_MS);
    return;
  }

  try {
    // How many slots are free?
    const slotsAvailable = MAX_CONCURRENT_JOBS - activeJobCount;
    if (slotsAvailable <= 0) {
      schedulePoll(MIN_POLL_MS); // Busy — check again soon
      return;
    }

    // Grab up to `slotsAvailable` pending jobs in one query
    const jobs = await prisma.videoDeliveryJob.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { lockedUntil: null },
          { lockedUntil: { lt: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: slotsAvailable,
    });

    if (jobs.length === 0) {
      // Nothing to do — back off (5s → 10s → 20s → 40s → 60s)
      currentPollMs = Math.min(currentPollMs * 2, MAX_POLL_MS);
      schedulePoll(currentPollMs);
      return;
    }

    // Found work — reset to fast polling
    currentPollMs = MIN_POLL_MS;

    for (const job of jobs) {
      // Optimistic lock — only one worker can claim this job
      const lockResult = await prisma.videoDeliveryJob.updateMany({
        where: {
          id: job.id,
          status: 'PENDING',
          OR: [
            { lockedUntil: null },
            { lockedUntil: { lt: new Date() } },
          ],
        },
        data: {
          status: 'PROCESSING',
          lockedUntil: new Date(Date.now() + 10 * 60000), // lock for 10 min
          attempts: { increment: 1 },
        },
      });

      if (lockResult.count === 0) continue; // Another instance grabbed it

      // Run async — don't await, so all concurrent jobs run in parallel
      activeJobCount++;
      processJob(job.id)
        .catch(async (err: any) => {
          console.error(`[Job] Failed for job ${job.id}:`, err);
          const errorMsg = err?.message ?? String(err);
          try {
            await prisma.videoDeliveryJob.update({
              where: { id: job.id },
              data: { status: 'FAILED', error: errorMsg },
            });
            await prisma.order.update({
              where: { id: job.orderId },
              data: { status: 'CONFIRMED' }, // Reset so admin can see it
            });
            console.error(`[Queue] Job ${job.id} for order ${job.orderId} marked FAILED`);
          } catch (markErr) {
            console.error(`[Queue] Could not mark job as FAILED:`, markErr);
          }
        })
        .finally(() => {
          activeJobCount--;
        });
    }

    schedulePoll(currentPollMs);
  } catch (err) {
    console.error(`[Queue] Worker poll error:`, err);
    if (isQuotaError(err)) {
      tripBreaker();
      schedulePoll(MAX_POLL_MS);
    } else {
      // Generic error — slow down but don't trip breaker
      currentPollMs = Math.min(currentPollMs * 2, MAX_POLL_MS);
      schedulePoll(currentPollMs);
    }
  }
}

function schedulePoll(ms: number) {
  if (stopped) return;
  pollTimeout = setTimeout(pollOnce, ms);
}

export const createVideoDeliveryWorker = () => {
  console.log('[Queue] Starting Postgres-based video delivery worker (backoff + circuit breaker)...');
  stopped = false;
  currentPollMs = MIN_POLL_MS;
  schedulePoll(MIN_POLL_MS);

  return {
    close: async () => {
      stopped = true;
      if (pollTimeout) clearTimeout(pollTimeout);
      console.log('[Queue] Postgres worker stopped');
    }
  };
};
