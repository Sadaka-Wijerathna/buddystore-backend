import { Bot, Context, InlineKeyboard } from 'grammy';
import config from '../config';
import prisma from '../lib/prisma';
import { videoDeliveryQueue } from '../jobs/video.queue';

// Main bot instance — exported so auth controller and webhook router can use it
export const mainBot = new Bot(config.bots.main);

// Safety: Add global error handler to prevent bot/network errors from crashing the app
mainBot.catch((err) => {
  console.error('[MainBot] ❌ Global Bot Error:', err);
});

// ─── Global Sync Middleware ───────────────────────────────────────────────────
// Whenever a user interacts with the bot, we check if their username or name has changed
// and silently update the database so they can always log in with their latest username.
mainBot.use(async (ctx, next) => {
  if (ctx.from && ctx.from.id) {
    // Fire and forget so we don't block the actual bot command
    prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) }, select: { id: true, telegramUsername: true, firstName: true, lastName: true } })
      .then(user => {
        if (user) {
          const currentUsername = (ctx.from?.username || '').toLowerCase();
          const dbUsername = (user.telegramUsername || '').toLowerCase();
          
          if (
            currentUsername !== dbUsername || 
            user.firstName !== ctx.from?.first_name || 
            user.lastName !== (ctx.from?.last_name || null)
          ) {
            const isUsernameChanged = currentUsername && currentUsername !== dbUsername;
            prisma.user.update({
              where: { id: user.id },
              data: {
                telegramUsername: ctx.from?.username || user.telegramUsername, // use fallback if they removed it
                firstName: ctx.from?.first_name,
                lastName: ctx.from?.last_name || null,
                ...(isUsernameChanged && {
                  oldTelegramUsername: user.telegramUsername,
                  usernameUpdatedAt: new Date(),
                })
              }
            }).catch(() => {});
          }
        }
      }).catch(() => {});
  }
  return next();
});

 mainBot.command('start', async (ctx: Context) => {
  const payload = ctx.match as string | undefined; // The token passed in ?start=TOKEN
  const from = ctx.from;

  if (!from) {
    await ctx.reply('⚠️ Could not identify your account. Please try again.');
    return;
  }

  // If no token in start payload, just greet
  if (!payload) {
    const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',')[0] : 'https://tgbuddy.store';
    await ctx.reply(
      `👋 Welcome to BuddyStore!\n\nUse our website to register your account at ${frontendUrl}/register`
    );
    return;
  }

  // Handle preview video delivery
  if (payload.startsWith('preview_')) {
    const videoId = payload.replace('preview_', '').trim();
    try {
      const video = await prisma.videos.findUnique({ where: { id: videoId } });
      if (video) {
        await ctx.replyWithVideo(video.fileId, {
          caption: 'Here is the video you requested from the gallery preview! 🎁'
        });
      } else {
        await ctx.reply('❌ Video not found or no longer available.');
      }
    } catch (e) {
      console.error(`[MainBot] preview error:`, e);
      await ctx.reply('❌ Something went wrong while retrieving the video.');
    }
    return;
  }

  // Look up the registration token
  const regToken = await prisma.registrationToken.findUnique({
    where: { token: payload },
  });

  if (!regToken) {
    await ctx.reply('❌ Invalid or expired verification link. Please start the registration again.');
    return;
  }

  if (new Date() > regToken.expiresAt) {
    await ctx.reply('⏰ This link has expired. Please go back to the website and restart registration.');
    return;
  }

  if (regToken.verified) {
    await ctx.reply('✅ Already verified! Go back to the website to complete your registration.');
    return;
  }

  // ── Username mismatch check ──────────────────────────────────────────────────
  // The person who starts the bot MUST be the same account entered in Step 1.
  // Compare case-insensitively since Telegram usernames are case-insensitive.
  const botStarter = (from.username ?? '').toLowerCase();
  const expectedUsername = regToken.telegramUsername.toLowerCase();

  if (!from.username) {
    await ctx.reply(
      `❌ Your Telegram account doesn't have a username set.\n\nPlease set a username in Telegram Settings and try again.`
    );
    return;
  }

  if (botStarter !== expectedUsername) {
    await ctx.reply(
      `❌ *Wrong account!*\n\nThis verification link was created for @${regToken.telegramUsername}.\n\nYou are currently logged in as @${from.username}.\n\nPlease open this link on the correct Telegram account.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Check if a user with this telegram_id already exists
  const existingUser = await prisma.user.findUnique({
    where: { telegramId: BigInt(from.id) },
  });

  if (existingUser) {
    await ctx.reply('⚠️ This Telegram account is already registered. Please log in on the website.');
    return;
  }

  // Update the token with collected user info and mark as verified
  await prisma.registrationToken.update({
    where: { token: payload },
    data: {
      telegramId: BigInt(from.id),
      firstName: from.first_name,
      lastName: from.last_name || null,
      languageCode: from.language_code || null,
      verified: true,
    },
  });

  await ctx.reply(
    `✅ *Verified!*\n\nHello, ${from.first_name}! 🎉\n\nYour account has been linked. Go back to the website to set your password and complete registration.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /help Command ────────────────────────────────────────────────────────────
mainBot.command('help', async (ctx: Context) => {
  const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',')[0] : 'https://tgbuddy.store';

  const helpMessage = `
🛍️ *Welcome to BuddyStore!*
_Your #1 Telegram video store_

━━━━━━━━━━━━━━━━━━━━
🔐 *How to Get Started*
━━━━━━━━━━━━━━━━━━━━
1️⃣ Go to [tgbuddy.store](${frontendUrl}/register)
2️⃣ Enter your *Telegram username*
3️⃣ Click the verification link sent here
4️⃣ Set your password — you're in! ✅

━━━━━━━━━━━━━━━━━━━━
🎬 *How to Buy Videos*
━━━━━━━━━━━━━━━━━━━━
• Browse our video categories on the website
• Add packs to your cart 🛒
• Choose your payment method and checkout
• Videos are delivered *directly in this chat* 📩

━━━━━━━━━━━━━━━━━━━━
💳 *Payment Methods*
━━━━━━━━━━━━━━━━━━━━
⭐ *Telegram Stars* — Instant, no hassle
💰 *Crypto* — USDT & more accepted
🏦 *Bank Transfer* — Manual verification

━━━━━━━━━━━━━━━━━━━━
📦 *Video Delivery*
━━━━━━━━━━━━━━━━━━━━
• After payment is confirmed, videos are sent here automatically
• Delivery starts within seconds of order confirmation
• Each video pack contains the exact count you purchased

━━━━━━━━━━━━━━━━━━━━
📊 *Manage Your Account*
━━━━━━━━━━━━━━━━━━━━
• View orders & history → [Dashboard](${frontendUrl}/dashboard)
• Check your balance & top up → [Wallet](${frontendUrl}/dashboard/wallet)
• Browse all categories → [Shop](${frontendUrl})

━━━━━━━━━━━━━━━━━━━━
🆘 *Need Help?*
━━━━━━━━━━━━━━━━━━━━
Contact our support or visit the website for more info.

🌐 [tgbuddy.store](${frontendUrl})
`.trim();

  await ctx.reply(helpMessage, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
  });
});


mainBot.on('message', async (ctx: Context) => {
  const from = ctx.from;
  if (!from) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(from.id) },
  });

  const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',')[0] : 'https://tgbuddy.store';
  if (user) {
    await ctx.reply(`👋 Hi ${user.firstName}! Visit ${frontendUrl}/dashboard to manage your account.`);
  } else {
    await ctx.reply(`👋 Welcome! Register at ${frontendUrl}/register to get started.`);
  }
});

// ─── Telegram Stars Payment Handlers ──────────────────────────────────────────

/** 
 * Step 1: Pre-Checkout Query
 * Telegram asks the bot if we want to accept this payment.
 * We approve all queries because the inventory is digital and infinite.
 */
mainBot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true).catch((err) => {
    console.error('[MainBot] Failed to answer pre_checkout_query:', err);
  });
});

/**
 * Step 2: Successful Payment
 * Triggered after the user completes the Star payment in the native Telegram UI.
 */
mainBot.on('message:successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  const rawPayload = payment.invoice_payload; // We store order IDs
  const telegramPaymentId = payment.telegram_payment_charge_id;

  if (!rawPayload) return;

  try {
    if (rawPayload.startsWith('attempt:')) {
      const attemptId = rawPayload.substring(8);
      console.log(`[MainBot] ⭐️ Payment Received for attempt: ${attemptId}`);
      
      const attempt = await prisma.starsPaymentAttempt.findUnique({
        where: { id: attemptId }
      });

      if (!attempt) {
        console.error(`[MainBot] Stars attempt ${attemptId} not found!`);
        await ctx.reply('⚠️ Payment received, but we could not find your cart data. Please return to the website and contact support if your order is not confirmed.');
        return;
      }

      // Mark as paid - order creation is now deferred to the frontend "Place Order" click
      await prisma.starsPaymentAttempt.update({
        where: { id: attemptId },
        data: { 
          paid: true,
          starsTransactionId: telegramPaymentId
        }
      });

      await ctx.reply(`✅ *Payment Received!* ⭐️\n\nYour payment has been verified. Please return to the BuddyStore website to complete your order!`, { parse_mode: 'Markdown' });

    } else {
      // BACKWARDS COMPATIBILITY: Support old batch: format
      const orderIdsArr = rawPayload.startsWith('batch:') 
        ? rawPayload.substring(6).split(',') 
        : rawPayload.split(',');

      console.log(`[MainBot] ⭐️ Payment Successful for existing batch: ${orderIdsArr.join(',')}`);

      await prisma.order.updateMany({
        where: { id: { in: orderIdsArr } },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          starsTransactionId: telegramPaymentId
        }
      });

      const orders = await prisma.order.findMany({
        where: { id: { in: orderIdsArr } },
        include: { user: true }
      });

      for (const o of orders) {
        await videoDeliveryQueue.add(
          'deliver-videos',
          {
            orderId: o.id,
            userId: o.userId,
            userTelegramId: o.user.telegramId.toString(),
            category: o.category,
            videoCount: o.videoCount,
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
        );
      }

      await ctx.reply(`✅ *Payment Successful!* ⭐️\n\nYour orders have been created and confirmed. The bot will start sending your videos in this chat immediately!`, { parse_mode: 'Markdown' });
    }

  } catch (err) {
    console.error('[MainBot] Error processing successful payment:', err);
    await ctx.reply('⚠️ Your payment was successful, but we encountered an error setting up your delivery. Please contact support.');
  }
});



// ─── Webhook Registration ─────────────────────────────────────────────────────
// Called once on server startup. Tells Telegram to push all updates
// to our HTTPS endpoint instead of us polling getUpdates continuously.
// This eliminates 409 Conflict errors on Render restarts entirely.
export const registerMainBotWebhook = async (baseUrl: string, secret?: string): Promise<void> => {
  if (!config.bots.main) {
    console.warn('⚠️  MAIN_BOT_TOKEN not set — main bot webhook not registered');
    return;
  }
  const webhookUrl = `${baseUrl}/webhooks/main`;
  console.log(`🤖 Registering Main Bot webhook → ${webhookUrl}`);
  try {
    await mainBot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      ...(secret ? { secret_token: secret } : {}),
    });
    console.log('✅ Main Bot webhook registered');
  } catch (err: any) {
    console.error(`❌ Main Bot: Failed to register webhook — ${err.message}`);
  }
};

// ─── Webhook Deregistration ───────────────────────────────────────────────────
// Called on graceful shutdown so the next boot starts clean.
export const deregisterMainBotWebhook = async (): Promise<void> => {
  if (!config.bots.main) return;
  try {
    await mainBot.api.deleteWebhook({ drop_pending_updates: true });
    console.log('🤖 Main Bot webhook deregistered');
  } catch (err: any) {
    console.error(`❌ Main Bot: Failed to deregister webhook — ${err.message}`);
  }
};
