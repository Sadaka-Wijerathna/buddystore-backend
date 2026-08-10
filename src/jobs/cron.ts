import cron from 'node-cron';
import prisma from '../lib/prisma';
import { CryptoService } from '../services/crypto.service';
import { videoDeliveryQueue } from './video.queue';
import { getIO } from '../lib/socket';

import { syncTelegramProfile } from '../controllers/auth.controller';

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

  // ── Background Profile Sync — every hour ─────────────────────────────────
  // Silently updates all users' usernames, names, and profile pictures from Telegram.
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('[Cron] 🔄 Starting hourly background profile sync...');
      const users = await prisma.user.findMany({
        select: { id: true, telegramId: true, telegramUsername: true, firstName: true, lastName: true, photoUrl: true }
      });
      
      let updatedCount = 0;
      for (const u of users) {
        if (!u.telegramId) continue;
        try {
          const profile = await syncTelegramProfile(u.telegramId);
          if (profile) {
            const hasChanged = 
              profile.photoUrl !== u.photoUrl ||
              profile.firstName !== u.firstName ||
              profile.lastName !== u.lastName ||
              (profile.username || u.telegramUsername) !== u.telegramUsername;
              
            if (hasChanged) {
              const isUsernameChanged = profile.username && profile.username !== u.telegramUsername;
              await prisma.user.update({
                where: { id: u.id },
                data: {
                  photoUrl: profile.photoUrl,
                  firstName: profile.firstName,
                  lastName: profile.lastName,
                  telegramUsername: profile.username || u.telegramUsername,
                  ...(isUsernameChanged && {
                    oldTelegramUsername: u.telegramUsername,
                    usernameUpdatedAt: new Date(),
                  })
                }
              });
              updatedCount++;
            }
          }
          // Small delay to prevent rate-limiting (30 requests/sec limit by Telegram)
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (err) {
          // Ignore individual user errors
        }
      }
      console.log(`[Cron] ✅ Hourly profile sync complete. Updated ${updatedCount} users.`);
    } catch (error) {
      console.error('[Cron] Error in hourly profile sync:', error);
    }
  });


  console.log('✅ Cron jobs initialized');
}
