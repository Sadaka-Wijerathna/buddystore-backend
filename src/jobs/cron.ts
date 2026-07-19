import cron from 'node-cron';
import prisma from '../lib/prisma';
import { CryptoService } from '../services/crypto.service';
import { videoDeliveryQueue } from './video.queue';
import { getIO } from '../lib/socket';

export function initCronJobs() {
  // ── Stale Job Cleanup — every 10 minutes ─────────────────────────────────
  // If a job is stuck in PROCESSING for > 10 min (e.g. server crashed mid-delivery),
  // reset it to PENDING so the worker can pick it up again.
  cron.schedule('*/10 * * * *', async () => {
    try {
      const staleThreshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      const result = await prisma.videoDeliveryJob.updateMany({
        where: {
          status: 'PROCESSING',
          updatedAt: { lt: staleThreshold },
        },
        data: {
          status: 'PENDING',
          lockedUntil: null,
          error: 'Auto-reset: job was stuck in PROCESSING',
        },
      });
      if (result.count > 0) {
        console.log(`[Cron] ♻️  Reset ${result.count} stale PROCESSING job(s) back to PENDING`);
      }
    } catch (error) {
      console.error('[Cron] Error cleaning up stale jobs:', error);
    }
  });

  // ── Auto-Retry FAILED Jobs — every 15 minutes ────────────────────────────
  // If a job failed but has had less than 3 attempts, reset it to PENDING.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await prisma.videoDeliveryJob.updateMany({
        where: {
          status: 'FAILED',
          attempts: { lt: 3 },
        },
        data: {
          status: 'PENDING',
          lockedUntil: null,
          error: 'Auto-retrying FAILED job',
        },
      });
      if (result.count > 0) {
        console.log(`[Cron] 🔄 Auto-retrying ${result.count} FAILED job(s)`);
      }
    } catch (error) {
      console.error('[Cron] Error auto-retrying FAILED jobs:', error);
    }
  });


  console.log('✅ Cron jobs initialized');
}
