import { Bot, Context, InlineKeyboard } from 'grammy';
import config from '../config';
import prisma from '../lib/prisma';
import { videoDeliveryQueue } from '../jobs/video.queue';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

// Main bot instance — exported so auth controller and webhook router can use it
export const mainBot = new Bot(config.bots.main);

// Safety: Add global error handler to prevent bot/network errors from crashing the app
mainBot.catch((err) => {
  console.error('[MainBot] ❌ Global Bot Error:', err);
});

// ─── Helper: get frontend URL ─────────────────────────────────────────────────
function getFrontendUrl(): string {
  return process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')[0]
    : 'https://tgbuddy.store';
}

// ─── Helper: build standard quick-nav keyboard ───────────────────────────────
function navKeyboard(frontendUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url('🛍 Shop', frontendUrl)
    .url('📊 Dashboard', `${frontendUrl}/dashboard`)
    .row()
    .url('💰 Wallet', `${frontendUrl}/dashboard/wallet`)
    .url('⚙️ Settings', `${frontendUrl}/dashboard/settings`);
}

// ─── Global Sync Middleware ───────────────────────────────────────────────────
// Whenever a user interacts with the bot, we check if their username or name
// has changed and silently update the database.
mainBot.use(async (ctx, next) => {
  if (ctx.from && ctx.from.id) {
    // Fire and forget so we don't block the actual bot command
    prisma.user
      .findUnique({
        where: { telegramId: BigInt(ctx.from.id) },
        select: { id: true, telegramUsername: true, firstName: true, lastName: true },
      })
      .then((user) => {
        if (user) {
          const currentUsername = (ctx.from?.username || '').toLowerCase();
          const dbUsername = (user.telegramUsername || '').toLowerCase();

          if (
            currentUsername !== dbUsername ||
            user.firstName !== ctx.from?.first_name ||
            user.lastName !== (ctx.from?.last_name || null)
          ) {
            const isUsernameChanged = currentUsername && currentUsername !== dbUsername;
            prisma.user
              .update({
                where: { id: user.id },
                data: {
                  telegramUsername: ctx.from?.username || user.telegramUsername,
                  firstName: ctx.from?.first_name,
                  lastName: ctx.from?.last_name || null,
                  ...(isUsernameChanged && {
                    oldTelegramUsername: user.telegramUsername,
                    usernameUpdatedAt: new Date(),
                  }),
                },
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
  }
  return next();
});

// ─── /start Command ───────────────────────────────────────────────────────────
mainBot.command('start', async (ctx: Context) => {
  const payload = ctx.match as string | undefined;
  const from = ctx.from;
  const frontendUrl = getFrontendUrl();

  if (!from) {
    await ctx.reply('⚠️ Could not identify your account. Please try again.');
    return;
  }

  // ── No payload: welcome back or new user ──────────────────────────────────
  if (!payload) {
    const existingUser = await prisma.user.findUnique({
      where: { telegramId: BigInt(from.id) },
      select: { id: true, firstName: true, telegramUsername: true },
    });

    if (existingUser) {
      const kb = new InlineKeyboard()
        .url('📊 Go to Dashboard', `${frontendUrl}/dashboard`)
        .row()
        .url('🛍 Shop Videos', frontendUrl)
        .url('💰 My Wallet', `${frontendUrl}/dashboard/wallet`);

      await ctx.reply(
        `👋 Welcome back, *${existingUser.firstName}!*\n\nYou already have a BuddyStore account. What would you like to do?`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
      return;
    }

    if (!from.username) {
      await ctx.reply(
        `👋 Welcome to BuddyStore!\n\n⚠️ *You need a Telegram username to create an account.*\n\nPlease go to Telegram Settings → Set a username, then come back and send /start again.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const usernameTaken = await prisma.user.findUnique({
      where: { telegramUsername: from.username.toLowerCase() },
    });
    if (usernameTaken) {
      const kb = new InlineKeyboard().url('🔗 Login Now', `${frontendUrl}/login`);
      await ctx.reply(
        `⚠️ A BuddyStore account already exists for @${from.username}.\n\nIf this is your account, please log in:`,
        { reply_markup: kb }
      );
      return;
    }

    // ── Auto-create account ────────────────────────────────────────────────
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const tempPassword =
      'BStore_' +
      Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const referralCode = randomUUID().split('-')[0].toUpperCase();

    try {
      await prisma.user.create({
        data: {
          telegramId: BigInt(from.id),
          telegramUsername: from.username.toLowerCase(),
          firstName: from.first_name,
          lastName: from.last_name || null,
          languageCode: from.language_code || null,
          passwordHash,
          referralCode,
          role: 'USER',
        },
      });

      const kb = new InlineKeyboard()
        .url('🔗 Login Now', `${frontendUrl}/login`)
        .row()
        .url('🔒 Change Password', `${frontendUrl}/dashboard/settings`);

      await ctx.reply(
        `✅ *Account Created!*\n\nHello, ${from.first_name}! Your BuddyStore account has been set up.\n\n` +
          `👤 *Username:* @${from.username}\n` +
          `🔐 *Temporary Password:* \`${tempPassword}\`\n\n` +
          `⚠️ Please change your password after logging in.\n\n` +
          `Videos will be delivered here after you place an order! 🎬`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
    } catch (createErr) {
      console.error('[MainBot] Auto-registration failed:', createErr);
      await ctx.reply(`❌ Something went wrong setting up your account. Please contact the admin.`);
    }
    return;
  }

  // ── Preview video delivery ─────────────────────────────────────────────────
  if (payload.startsWith('preview_')) {
    const videoId = payload.replace('preview_', '').trim();
    try {
      const video = await prisma.videos.findUnique({ where: { id: videoId } });
      if (video) {
        const kb = new InlineKeyboard().url('🛍 Browse More', frontendUrl);
        await ctx.replyWithVideo(video.fileId, {
          caption: 'Here is the video you requested from the gallery preview! 🎁',
          reply_markup: kb,
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

  // ── Registration token verification ───────────────────────────────────────
  const regToken = await prisma.registrationToken.findUnique({ where: { token: payload } });

  if (!regToken) {
    await ctx.reply('❌ Invalid or expired verification link. Please start the registration again.');
    return;
  }

  if (new Date() > regToken.expiresAt) {
    const kb = new InlineKeyboard().url('🔄 Start Over', `${frontendUrl}/register`);
    await ctx.reply('⏰ This link has expired. Please restart registration:', {
      reply_markup: kb,
    });
    return;
  }

  if (regToken.verified) {
    const kb = new InlineKeyboard().url('✅ Complete Registration', `${frontendUrl}/register`);
    await ctx.reply('✅ Already verified! Go back to the website to complete registration.', {
      reply_markup: kb,
    });
    return;
  }

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

  const existingUser = await prisma.user.findUnique({ where: { telegramId: BigInt(from.id) } });
  if (existingUser) {
    const kb = new InlineKeyboard().url('🔗 Login', `${frontendUrl}/login`);
    await ctx.reply('⚠️ This Telegram account is already registered. Please log in:', {
      reply_markup: kb,
    });
    return;
  }

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

  const kb = new InlineKeyboard().url('✅ Complete Registration', `${frontendUrl}/register`);
  await ctx.reply(
    `✅ *Verified!*\n\nHello, ${from.first_name}! 🎉\n\nYour account has been linked. Go back to the website to set your password and complete registration.`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

// ─── /help Command ────────────────────────────────────────────────────────────
mainBot.command('help', async (ctx: Context) => {
  const frontendUrl = getFrontendUrl();

  const helpMessage = `
🛍️ *Welcome to BuddyStore!*
_Your #1 Telegram video store_

*Getting Started*
1️⃣ Visit BuddyStore and register
2️⃣ Enter your Telegram username
3️⃣ Click the verification link sent here
4️⃣ Set your password — you're in! ✅

*How to Buy Videos*
• Browse video categories on the website
• Add packs to your cart and checkout
• Videos are delivered directly in this chat 📩

*Payment Methods*
⭐ Telegram Stars — Instant
💰 Crypto — USDT & more
🏦 Bank Transfer — Manual verification

*Video Delivery*
• Delivery starts within seconds of order confirmation
• Each pack contains the exact count you purchased
`.trim();

  const kb = new InlineKeyboard()
    .url('🛍 Shop Now', frontendUrl)
    .url('📊 Dashboard', `${frontendUrl}/dashboard`)
    .row()
    .url('💰 My Wallet', `${frontendUrl}/dashboard/wallet`)
    .url('⚙️ Settings', `${frontendUrl}/dashboard/settings`);

  await ctx.reply(helpMessage, {
    parse_mode: 'Markdown',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
});

// ─── /settings Command ────────────────────────────────────────────────────────
mainBot.command('settings', async (ctx: Context) => {
  const from = ctx.from;
  if (!from) return;
  const frontendUrl = getFrontendUrl();

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(from.id) },
    select: {
      firstName: true,
      lastName: true,
      telegramUsername: true,
      role: true,
      walletBalance: true,
      createdAt: true,
    },
  });

  if (!user) {
    const kb = new InlineKeyboard().url('📝 Register Now', `${frontendUrl}/register`);
    await ctx.reply(
      `⚠️ *No BuddyStore account found.*\n\nRegister to get started!`,
      { parse_mode: 'Markdown', reply_markup: kb, link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const memberSince = user.createdAt.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const balance = Number(user.walletBalance).toFixed(2);

  const settingsMessage = `
*Your BuddyStore Account*

👤 Name: ${user.firstName}${user.lastName ? ' ' + user.lastName : ''}
🔖 Username: @${user.telegramUsername || 'not set'}
📅 Member Since: ${memberSince}
🔑 Role: ${user.role === 'ADMIN' ? 'Admin' : 'User'}

💰 Wallet Balance: *\$${balance}*
`.trim();

  const kb = new InlineKeyboard()
    .url('📊 Dashboard', `${frontendUrl}/dashboard`)
    .url('💰 Top Up', `${frontendUrl}/dashboard/wallet`)
    .row()
    .url('👤 Edit Profile', `${frontendUrl}/dashboard/profile`)
    .url('🛍 Shop', frontendUrl);

  await ctx.reply(settingsMessage, {
    parse_mode: 'Markdown',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
});

// ─── /balance Command ─────────────────────────────────────────────────────────
mainBot.command('balance', async (ctx: Context) => {
  const from = ctx.from;
  if (!from) return;
  const frontendUrl = getFrontendUrl();

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(from.id) },
    select: { firstName: true, walletBalance: true },
  });

  if (!user) {
    const kb = new InlineKeyboard().url('📝 Register', `${frontendUrl}/register`);
    await ctx.reply('⚠️ No BuddyStore account found.', { reply_markup: kb });
    return;
  }

  const balance = Number(user.walletBalance).toFixed(2);
  const kb = new InlineKeyboard()
    .url('💳 Top Up Wallet', `${frontendUrl}/dashboard/wallet`)
    .row()
    .url('🛍 Shop Videos', frontendUrl);

  await ctx.reply(
    `💰 *Wallet Balance*\n\nHi ${user.firstName}!\n\nYour current balance: *\$${balance}*`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

// ─── /orders Command ──────────────────────────────────────────────────────────
mainBot.command('orders', async (ctx: Context) => {
  const from = ctx.from;
  if (!from) return;
  const frontendUrl = getFrontendUrl();

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(from.id) },
    select: { id: true, firstName: true },
  });

  if (!user) {
    const kb = new InlineKeyboard().url('📝 Register', `${frontendUrl}/register`);
    await ctx.reply('⚠️ No BuddyStore account found.', { reply_markup: kb });
    return;
  }

  const orders = await prisma.order.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      category: true,
      videoCount: true,
      status: true,
      paymentMethod: true,
      createdAt: true,
    },
  });

  if (orders.length === 0) {
    const kb = new InlineKeyboard().url('🛍 Place First Order', frontendUrl);
    await ctx.reply(
      `📦 *No orders yet, ${user.firstName}!*\n\nVisit BuddyStore to place your first order.`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
    return;
  }

  const statusEmoji: Record<string, string> = {
    PENDING: '⏳',
    CONFIRMED: '✅',
    PROCESSING: '🔄',
    DELIVERED: '📦',
    CANCELLED: '❌',
    PENDING_PAYMENT: '💳',
    FAILED: '❗',
  };

  const lines = orders.map((o, i) => {
    const emoji = statusEmoji[o.status] ?? '❓';
    const date = o.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${i + 1}. ${emoji} *${o.category}* — ${o.videoCount} videos\n   ${o.status} · ${o.paymentMethod} · ${date}`;
  });

  const kb = new InlineKeyboard()
    .url('📊 View All Orders', `${frontendUrl}/dashboard/orders`)
    .row()
    .url('🛍 Shop More', frontendUrl);

  await ctx.reply(
    `📦 *Your Recent Orders*\n\n${lines.join('\n\n')}`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

// ─── Catch-all Message Handler ────────────────────────────────────────────────
// Handles any plain text/message that isn't a command.
mainBot.on('message', async (ctx: Context) => {
  const from = ctx.from;
  if (!from) return;
  const frontendUrl = getFrontendUrl();

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(from.id) },
    select: { firstName: true, walletBalance: true },
  });

  if (user) {
    // Registered user — show quick action keyboard
    const balance = Number(user.walletBalance).toFixed(2);
    const kb = new InlineKeyboard()
      .url('📊 Dashboard', `${frontendUrl}/dashboard`)
      .url('🛍 Shop', frontendUrl)
      .row()
      .url('💰 Wallet ($' + balance + ')', `${frontendUrl}/dashboard/wallet`)
      .url('📦 My Orders', `${frontendUrl}/dashboard/orders`);

    await ctx.reply(
      `👋 Hi *${user.firstName}!*\n\nUse the buttons below or type a command:\n/help · /balance · /orders · /settings`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  } else {
    // Unregistered user — prompt to register
    const kb = new InlineKeyboard()
      .url('📝 Create Account', `${frontendUrl}/register`)
      .row()
      .url('🔗 Login', `${frontendUrl}/login`);

    await ctx.reply(
      `👋 Welcome to *BuddyStore!*\n\nI don't have an account linked to this Telegram. Register to start buying videos! 🎬`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  }
});

// ─── Telegram Stars Payment Handlers ──────────────────────────────────────────

/**
 * Step 1: Pre-Checkout Query
 * Telegram asks the bot if we want to accept this payment.
 * We validate stock before answering — if a category ran out between invoice
 * creation and payment, we reject here so Stars are never deducted.
 * Must respond within 10 seconds per Telegram's API requirement.
 */
mainBot.on('pre_checkout_query', async (ctx) => {
  const rawPayload = ctx.preCheckoutQuery.invoice_payload;

  // Only validate "attempt:" payloads (our Stars flow)
  if (!rawPayload?.startsWith('attempt:')) {
    await ctx.answerPreCheckoutQuery(true).catch((err) => {
      console.error('[MainBot] Failed to answer pre_checkout_query:', err);
    });
    return;
  }

  const attemptId = rawPayload.substring(8);

  try {
    const attempt = await prisma.starsPaymentAttempt.findUnique({ where: { id: attemptId } });

    if (!attempt) {
      await ctx.answerPreCheckoutQuery(
        false,
        'Your cart has expired. Please return to BuddyStore and create a new order.'
      );
      return;
    }

    if (attempt.paid) {
      await ctx.answerPreCheckoutQuery(
        false,
        'This order has already been paid. Please check your BuddyStore dashboard.'
      );
      return;
    }

    const items = attempt.items as { category: string; count: number; botId: string }[];

    const stockChecks = await Promise.all(
      items.map(async (item) => {
        const [totalVideos, alreadyReceived] = await Promise.all([
          prisma.videos.count({ where: { category: item.category } }),
          prisma.videoDelivery.count({
            where: { userId: attempt.userId, video: { category: item.category } },
          }),
        ]);
        const available = Math.max(0, totalVideos - alreadyReceived);
        return { category: item.category, needed: item.count, available };
      })
    );

    const outOfStock = stockChecks.filter((s) => s.available < s.needed);

    if (outOfStock.length > 0) {
      const names = outOfStock
        .map((s) => `${s.category} (need ${s.needed}, have ${s.available})`)
        .join(', ');
      console.warn(`[MainBot] pre_checkout_query REJECTED — insufficient stock: ${names}`);
      await ctx.answerPreCheckoutQuery(
        false,
        'Some items in your order are out of stock. Please return to BuddyStore, update your cart, and try again.'
      );
      return;
    }

    await ctx.answerPreCheckoutQuery(true);
  } catch (err) {
    console.error('[MainBot] Error validating pre_checkout_query:', err);
    await ctx.answerPreCheckoutQuery(true).catch(() => {});
  }
});

/**
 * Step 2: Successful Payment
 * Triggered after the user completes the Star payment in the native Telegram UI.
 */
mainBot.on('message:successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  const rawPayload = payment.invoice_payload;
  const telegramPaymentId = payment.telegram_payment_charge_id;
  const frontendUrl = getFrontendUrl();

  if (!rawPayload) return;

  try {
    if (rawPayload.startsWith('attempt:')) {
      const attemptId = rawPayload.substring(8);
      console.log(`[MainBot] ⭐️ Payment Received for attempt: ${attemptId}`);

      const attempt = await prisma.starsPaymentAttempt.findUnique({ where: { id: attemptId } });

      if (!attempt) {
        console.error(`[MainBot] Stars attempt ${attemptId} not found!`);
        await ctx.reply(
          '⚠️ Payment received, but we could not find your cart data. Please return to the website and contact support if your order is not confirmed.'
        );
        return;
      }

      await prisma.starsPaymentAttempt.update({
        where: { id: attemptId },
        data: { paid: true, starsTransactionId: telegramPaymentId },
      });

      const kb = new InlineKeyboard()
        .url('📦 Complete Order', `${frontendUrl}/dashboard`)
        .row()
        .url('📊 View Dashboard', `${frontendUrl}/dashboard`);

      await ctx.reply(
        `✅ *Payment Received!* ⭐️\n\nYour Stars payment has been verified. Please return to the BuddyStore website to complete your order!`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
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
          starsTransactionId: telegramPaymentId,
        },
      });

      const orders = await prisma.order.findMany({
        where: { id: { in: orderIdsArr } },
        include: { user: true },
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

      const kb = new InlineKeyboard()
        .url('📦 View Orders', `${frontendUrl}/dashboard/orders`)
        .row()
        .url('🛍 Shop More', frontendUrl);

      await ctx.reply(
        `✅ *Payment Successful!* ⭐️\n\nYour orders have been confirmed. Videos will be delivered in this chat shortly! 🎬`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
    }
  } catch (err) {
    console.error('[MainBot] Error processing successful payment:', err);
    await ctx.reply(
      '⚠️ Your payment was successful, but we encountered an error setting up your delivery. Please contact support.'
    );
  }
});

// ─── Webhook Registration ─────────────────────────────────────────────────────
// Called once on server startup. Tells Telegram to push all updates
// to our HTTPS endpoint instead of us polling getUpdates continuously.
export const registerMainBotWebhook = async (baseUrl: string, secret?: string): Promise<void> => {
  if (!config.bots.main) {
    console.warn('⚠️  MAIN_BOT_TOKEN not set — main bot webhook not registered');
    return;
  }
  const webhookUrl = `${baseUrl}/webhooks/main`;
  const frontendUrl = getFrontendUrl();

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

  // Register bot commands so they appear in the "/" suggestion menu and on
  // the bot's profile page (Help & Settings links shown by Telegram automatically)
  try {
    await mainBot.api.setMyCommands([
      { command: 'start',    description: 'Start / link your BuddyStore account' },
      { command: 'help',     description: 'How BuddyStore works & payment methods' },
      { command: 'balance',  description: 'Check your wallet balance' },
      { command: 'orders',   description: 'View your last 5 orders' },
      { command: 'settings', description: 'View your account info & quick links' },
    ]);
    console.log('✅ Main Bot commands registered');
  } catch (err: any) {
    console.error(`❌ Main Bot: Failed to register commands — ${err.message}`);
  }

  // Set the chat menu button to open BuddyStore directly — one tap from any chat
  try {
    await mainBot.api.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: '🛍 BuddyStore',
        web_app: { url: frontendUrl },
      },
    });
    console.log('✅ Main Bot menu button set → BuddyStore');
  } catch (err: any) {
    console.error(`❌ Main Bot: Failed to set menu button — ${err.message}`);
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
