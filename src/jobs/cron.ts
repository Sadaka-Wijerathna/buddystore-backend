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

  // ── Stars: Auto-fulfill orphaned paid attempts — every 30 minutes ─────────
  // If a user paid Stars but closed the website before clicking "Place Order",
  // their StarsPaymentAttempt is marked paid=true but no Order was ever created.
  // This job auto-fulfills those attempts so users never lose their Stars.
  cron.schedule('*/30 * * * *', async () => {
    try {
      // Find paid attempts older than 10 minutes (give the frontend time to fulfill normally)
      const threshold = new Date(Date.now() - 10 * 60 * 1000);
      const orphanedAttempts = await prisma.starsPaymentAttempt.findMany({
        where: {
          paid: true,
          createdAt: { lt: threshold },
        },
      });

      if (orphanedAttempts.length === 0) return;

      console.log(`[Cron] ⭐ Found ${orphanedAttempts.length} orphaned paid Stars attempt(s) — auto-fulfilling...`);

      // Batch-load all relevant users in one query
      const userIds = [...new Set(orphanedAttempts.map(a => a.userId))];
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, telegramId: true },
      });
      const userMap = new Map(users.map(u => [u.id, u]));

      for (const attempt of orphanedAttempts) {
        try {
          const items = attempt.items as any[];
          const userDb = userMap.get(attempt.userId);

          if (!userDb) {
            console.warn(`[Cron] User ${attempt.userId} not found for attempt ${attempt.id} — skipping`);
            continue;
          }

          // Create orders in a transaction
          const orderJobs: any[] = items.map((item: any) =>
            prisma.order.create({
              data: {
                userId: attempt.userId,
                botId: item.botId,
                category: item.category,
                videoCount: item.count,
                priceAmount: item.price,
                paymentMethod: 'STARS',
                starsTransactionId: attempt.starsTransactionId,
                status: 'CONFIRMED',
                confirmedAt: new Date(),
                receiptUrl: null,
              },
            })
          );

          // Delete the attempt record in the same transaction
          orderJobs.push(prisma.starsPaymentAttempt.delete({ where: { id: attempt.id } }));

          const results = await prisma.$transaction(orderJobs) as any[];
          const createdOrders = results.slice(0, items.length);

          // Queue video delivery for each created order
          for (const o of createdOrders) {
            await videoDeliveryQueue.add(
              'deliver-videos',
              {
                orderId: o.id,
                userId: attempt.userId,
                userTelegramId: userDb.telegramId.toString(),
                category: o.category,
                videoCount: o.videoCount,
              },
              { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
            );
          }

          // Notify user in Telegram
          const { mainBot } = await import('../bots/main.bot');
          await mainBot.api.sendMessage(
            userDb.telegramId.toString(),
            `✅ *Order Confirmed!* ⭐\n\nYour Stars payment has been processed and your videos are on their way! We noticed you left the website before completing the order — no worries, we've got you covered.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {}); // Don't fail the job if notification fails

          console.log(`[Cron] ⭐ Auto-fulfilled attempt ${attempt.id} → ${createdOrders.length} order(s) for user ${attempt.userId}`);
        } catch (err) {
          console.error(`[Cron] Failed to auto-fulfill Stars attempt ${attempt.id}:`, err);
        }
      }
    } catch (error) {
      console.error('[Cron] Error in Stars orphaned attempt auto-fulfillment:', error);
    }
  });


  // ── Stars: Delete stale unpaid attempts — daily at 2 AM ──────────────────
  // StarsPaymentAttempt records with paid=false older than 24h are dead —
  // the invoice link has expired and will never be paid. Clean them up.
  cron.schedule('0 2 * * *', async () => {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const result = await prisma.starsPaymentAttempt.deleteMany({
        where: {
          paid: false,
          createdAt: { lt: oneDayAgo },
        },
      });
      if (result.count > 0) {
        console.log(`[Cron] 🧹 Deleted ${result.count} stale unpaid Stars attempt(s).`);
      }
    } catch (error) {
      console.error('[Cron] Error cleaning up stale Stars attempts:', error);
    }
  });

  console.log('✅ Cron jobs initialized');
}

