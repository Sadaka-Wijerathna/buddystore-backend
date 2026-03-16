import { Queue, Worker, Job } from 'bullmq';
import { Category } from '@prisma/client';
import config from '../config';
import prisma from '../lib/prisma';
import { categoryBots } from '../bots/category.bot';
import { getIO } from '../lib/socket';
import type { Server as SocketIOServer } from 'socket.io';

/**
 * Safe wrapper around getIO() — returns null instead of throwing
 * when Socket.io hasn't been initialised (e.g. in a standalone worker process).
 */
function safeGetIO(): SocketIOServer | null {
  try {
    return getIO();
  } catch {
    return null;
  }
}

// ─── Redis connection options ───────────────────────────────────────────────────
// Upstash Redis uses TLS (rediss://) — we parse the URL and pass explicit
// tls options so ioredis can connect from Railway without ETIMEDOUT.
function getRedisConnection() {
  const redisUrl = config.redis.url;

  if (!redisUrl) {
    throw new Error('REDIS_URL is not set');
  }

  // Parse the rediss:// URL manually for ioredis
  const url = new URL(redisUrl);
  const isTls = url.protocol === 'rediss:';

  return {
    host: url.hostname,
    port: parseInt(url.port || (isTls ? '6380' : '6379'), 10),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: isTls ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 20000,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  };
}

// ─── Lazy Queue Getter ─────────────────────────────────────────────────────────
// Queue is created on-demand so it doesn't try to connect to Redis at startup
let _queue: Queue | null = null;

export const getVideoDeliveryQueue = (): Queue => {
  if (!_queue) {
    _queue = new Queue('video-delivery', {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }
  return _queue;
};

// Keep backward-compat alias used in admin controller
export const videoDeliveryQueue = {
  add: (...args: Parameters<Queue['add']>) => getVideoDeliveryQueue().add(...args),
};



// ─── Job Data Interface ────────────────────────────────────────────────────────
export interface VideoDeliveryJobData {
  orderId: string;
  userId: string;
  userTelegramId: string;  // stored as string to avoid BigInt JSON issues
  category: Category;
  videoCount: number;
}

// ─── Worker (processes the jobs) ─────────────────────────────────────────────
export const createVideoDeliveryWorker = () => {
  const worker = new Worker<VideoDeliveryJobData>(
    'video-delivery',
    async (job: Job<VideoDeliveryJobData>) => {
      const { orderId, userId, userTelegramId, category, videoCount } = job.data;
      const io = safeGetIO();

      console.log(`[Job] Starting video delivery for order ${orderId}`);

      // Mark order as DELIVERING
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'DELIVERING' },
      });

      // Notify frontend via WebSocket (skipped if Socket.io not available)
      io?.to(`order:${orderId}`).emit('order:status', {
        orderId,
        status: 'DELIVERING',
        delivered: 0,
        total: videoCount,
        percentComplete: 0,
      });

      // Get the correct category bot
      const bot = categoryBots[category];
      if (!bot) {
        throw new Error(`No bot found for category: ${category}`);
      }

      // Deliver videos with real-time progress updates
      const sentCount = await bot.sendVideosToUser(
        orderId,
        userId,
        BigInt(userTelegramId),
        videoCount,
        (sent, total) => {
          const percent = Math.round((sent / total) * 100);
          // Update job progress
          job.updateProgress(percent);

          // Emit real-time WS event to user's order room
          io?.to(`order:${orderId}`).emit('order:progress', {
            orderId,
            delivered: sent,
            total,
            percentComplete: percent,
          });
        }
      );

      // Mark order as COMPLETED
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });

      // Final WebSocket event
      io?.to(`order:${orderId}`).emit('order:status', {
        orderId,
        status: 'COMPLETED',
        delivered: sentCount,
        total: videoCount,
        percentComplete: 100,
      });

      console.log(`[Job] Order ${orderId} completed: ${sentCount}/${videoCount} videos sent`);
      return { orderId, sentCount };
    },
    {
      connection: getRedisConnection(),
      concurrency: 2, // Process max 2 delivery jobs at once
    }
  );

  worker.on('completed', (job) => {
    console.log(`[Queue] Job ${job.id} completed`);
  });

  worker.on('failed', async (job, err) => {
    console.error(`[Queue] Job ${job?.id} failed:`, err.message);
    if (job) {
      // If job failed after all retries, mark order as failed
      const isLastAttempt = job.attemptsMade >= (job.opts.attempts || 1);
      if (isLastAttempt) {
        await prisma.order.update({
          where: { id: job.data.orderId },
          data: { status: 'PENDING' }, // Revert to pending so admin can retry
        }).catch(console.error);
      }
    }
  });

  worker.on('progress', (job, progress) => {
    console.log(`[Queue] Job ${job.id} progress: ${progress}%`);
  });

  return worker;
};
