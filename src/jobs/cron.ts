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


  // Fix #11: Expired Token Cleanup — daily at 3 AM ──────────────────────────
  // RegistrationToken and PasswordResetOtp rows with past expiresAt accumulate
  // forever without cleanup. Prune them nightly to keep the DB lean.
  cron.schedule('0 3 * * *', async () => {
    try {
      const now = new Date();

      const [tokens, otps] = await Promise.all([
        prisma.registrationToken.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.passwordResetOtp.deleteMany({ where: { expiresAt: { lt: now } } }),
      ]);

      console.log(
        `[Cron] 🧹 Nightly token cleanup: deleted ${tokens.count} expired registration token(s) ` +
        `and ${otps.count} expired OTP(s).`
      );
    } catch (error) {
      console.error('[Cron] Error during token cleanup:', error);
    }
  });

  // Privacy: Weekly IP Wipe — every Sunday at 4 AM ─────────────────────────
  // Erase any lastIpAddress / deviceType values that may have been stored before
  // the privacy update. Runs weekly to catch any stragglers.
  cron.schedule('0 4 * * 0', async () => {
    try {
      const result = await prisma.user.updateMany({
        where: {
          OR: [
            { lastIpAddress: { not: null } },
            { deviceType: { not: null } },
          ],
        },
        data: {
          lastIpAddress: null,
          deviceType: null,
        },
      });
      if (result.count > 0) {
        console.log(`[Cron] 🔒 Privacy wipe: cleared IP/device data from ${result.count} user(s).`);
      }
    } catch (error) {
      console.error('[Cron] Error during privacy IP wipe:', error);
    }
  });

  // ── Super Badge Expiry Processing — daily at 1 AM ───────────────────────
  cron.schedule('0 1 * * *', async () => {
    try {
      const now = new Date();
      const expiredBadges = await prisma.superBadge.findMany({
        where: { status: 'ACTIVE', expiresAt: { lt: now } },
      });

      let processedCount = 0;
      for (const badge of expiredBadges) {
        await prisma.superBadge.delete({ where: { id: badge.id } });

        const { dispatchNotification } = await import('../controllers/notification.controller');
        await dispatchNotification(
          badge.userId,
          'badge_expired',
          '🏅 Super Badge Expired',
          'Your Super Badge has expired. Renew now to get unlimited perks back!'
        );
        processedCount++;
      }

      if (processedCount > 0) {
        console.log(`[Cron] 🏅 Processed ${processedCount} expired Super Badge(s).`);
      }
    } catch (error) {
      console.error('[Cron] Error processing expired Super Badges:', error);
    }
  });

  // ── Super Badge Warning — daily at 9 AM ─────────────────────────────────
  cron.schedule('0 9 * * *', async () => {
    try {
      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

      const warningBadges = await prisma.superBadge.findMany({
        where: { 
          status: 'ACTIVE',
          expiresAt: {
            gt: new Date(),
            lte: threeDaysFromNow,
          }
        },
      });

      let warningCount = 0;
      for (const badge of warningBadges) {
        const { dispatchNotification } = await import('../controllers/notification.controller');
        await dispatchNotification(
          badge.userId,
          'badge_warning',
          '⚠️ Super Badge Expiring Soon',
          `Your Super Badge will expire on ${badge.expiresAt.toLocaleDateString()}. Renew soon to keep your unlimited previews and saveable videos!`
        );
        warningCount++;
      }

      if (warningCount > 0) {
        console.log(`[Cron] 🏅 Sent ${warningCount} expiry warnings for Super Badges.`);
      }
    } catch (error) {
      console.error('[Cron] Error sending Super Badge warnings:', error);
    }
  });

  console.log('✅ Cron jobs initialized');
}
