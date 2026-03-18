import { Bot, Context } from 'grammy';
import config from '../config';
import prisma from '../lib/prisma';

// Main bot instance — exported so auth controller can use it to validate usernames
export const mainBot = new Bot(config.bots.main);

mainBot.command('start', async (ctx: Context) => {
  const payload = ctx.match as string | undefined; // The token passed in ?start=TOKEN
  const from = ctx.from;

  if (!from) {
    await ctx.reply('⚠️ Could not identify your account. Please try again.');
    return;
  }

  // If no token in start payload, just greet
  if (!payload) {
    await ctx.reply(
      `👋 Welcome to BuddyStore!\n\nUse our website to register your account at buddystore.com/register`
    );
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

// Handle messages from already-registered users
mainBot.on('message', async (ctx: Context) => {
  const from = ctx.from;
  if (!from) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(from.id) },
  });

  if (user) {
    await ctx.reply(`👋 Hi ${user.firstName}! Visit buddystore.com/dashboard to manage your account.`);
  } else {
    await ctx.reply(`👋 Welcome! Register at buddystore.com/register to get started.`);
  }
});

// Start the main bot (long polling)
export const startMainBot = async () => {
  console.log('🤖 Starting Main Bot...');
  mainBot.start({
    onStart: (info) => {
      console.log(`✅ Main Bot started: @${info.username}`);
    },
  });
};

// Stop the main bot
export const stopMainBot = async () => {
  if (mainBot.isInited()) {
    console.log('🤖 Stopping Main Bot...');
    await mainBot.stop();
  }
};
