import { Category } from '@prisma/client';
import prisma from '../lib/prisma';
import { categoryBots } from '../bots/category.bot';
import { getIO } from '../lib/socket';
import type { Server as SocketIOServer } from 'socket.io';

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
  category: Category;
  videoCount: number;
}

// Backward-compat alias for the admin controller
export const videoDeliveryQueue = {
  add: async (jobName: string, data: VideoDeliveryJobData, opts?: any) => {
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

let workerInterval: NodeJS.Timeout | null = null;

export const createVideoDeliveryWorker = () => {
  console.log('[Queue] Starting Postgres-based video delivery worker...');
  
  // Poll every 5 seconds
  workerInterval = setInterval(async () => {
    try {
      // Find oldest pending job that isn't locked
      const job = await prisma.videoDeliveryJob.findFirst({
        where: {
          status: 'PENDING',
          OR: [
            { lockedUntil: null },
            { lockedUntil: { lt: new Date() } }
          ]
        },
        orderBy: { createdAt: 'asc' }
      });

      if (!job) return;

      // Lock it for 5 minutes so other workers don't grab it concurrently
      // Using updateMany so we don't need a transaction (unsupported in Neon HTTP mode context)
      const lockResult = await prisma.videoDeliveryJob.updateMany({
        where: {
          id: job.id,
          status: 'PENDING',
          OR: [
            { lockedUntil: null },
            { lockedUntil: { lt: new Date() } }
          ]
        },
        data: { 
          status: 'PROCESSING', 
          lockedUntil: new Date(Date.now() + 5 * 60000), 
          attempts: { increment: 1 } 
        }
      });

      if (lockResult.count === 0) return; // Someone else grabbed it

      const pendingJob = await prisma.videoDeliveryJob.findUnique({ where: { id: job.id } });
      if (!pendingJob) return;
      
      const { id: jobId, orderId, userId, userTelegramId, category, videoCount } = pendingJob;
      const io = safeGetIO();
      console.log(`[Job] Starting video delivery for order ${orderId} (Job ${jobId})`);

      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'DELIVERING' },
      });

      io?.to(`order:${orderId}`).emit('order:status', {
        orderId,
        status: 'DELIVERING',
        delivered: 0,
        total: videoCount,
        percentComplete: 0,
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
          // Update db progress
          await prisma.videoDeliveryJob.update({ where: { id: jobId }, data: { progress: percent }});
          io?.to(`order:${orderId}`).emit('order:progress', {
            orderId, delivered: sent, total, percentComplete: percent,
          });
        }
      );

      // Job completed
      await prisma.videoDeliveryJob.update({ where: { id: jobId }, data: { status: 'COMPLETED', progress: 100 } });
      await prisma.order.update({ 
        where: { id: orderId }, 
        data: { status: 'COMPLETED', completedAt: new Date() } 
      });

      io?.to(`order:${orderId}`).emit('order:status', {
        orderId, status: 'COMPLETED', delivered: sentCount, total: videoCount, percentComplete: 100,
      });
      console.log(`[Job] Order ${orderId} completed: ${sentCount}/${videoCount} videos sent`);

    } catch (err: any) {
      console.error(`[Queue] Delivery Worker Error:`, err);
      // Wait for it to become unlocked to try again, eventually we could mark as FAILED
    }
  }, 5000);

  return {
    close: async () => {
      if (workerInterval) clearInterval(workerInterval);
      console.log('[Queue] Postgres worker stopped');
    }
  };
};
