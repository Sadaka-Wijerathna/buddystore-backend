/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  WEBHOOK RE-REGISTRATION SCRIPT                                  ║
 * ║                                                                  ║
 * ║  Run with:                                                       ║
 * ║    npx ts-node -r dotenv/config src/scripts/reregister-webhooks.ts
 * ║                                                                  ║
 * ║  This forcefully re-points ALL bot webhooks from the old         ║
 * ║  onrender.com URL to the current WEBHOOK_BASE_URL in .env        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import 'dotenv/config';
import prisma from '../lib/prisma';

const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET || '';
const SPECIAL_TOKEN    = process.env.BOT_SPECIAL_TOKEN || '';

const G    = '\x1b[32m';
const R    = '\x1b[31m';
const Y    = '\x1b[33m';
const B    = '\x1b[36m';
const RST  = '\x1b[0m';
const BOLD = '\x1b[1m';

function ok(msg: string)   { console.log(`${G}  ✅  ${msg}${RST}`); }
function fail(msg: string) { console.log(`${R}  ❌  ${msg}${RST}`); }
function warn(msg: string) { console.log(`${Y}  ⚠️   ${msg}${RST}`); }
function info(msg: string) { console.log(`${B}  ℹ️   ${msg}${RST}`); }

async function setWebhook(token: string, webhookUrl: string, botName: string): Promise<boolean> {
  const body: Record<string, any> = {
    url: webhookUrl,
    drop_pending_updates: true,
    allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
  };
  if (WEBHOOK_SECRET) {
    body.secret_token = WEBHOOK_SECRET;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json() as any;

  if (data.ok) {
    ok(`[${botName}] Webhook set → ${webhookUrl}`);
    return true;
  } else {
    fail(`[${botName}] Failed: ${data.description}`);
    return false;
  }
}

async function getWebhookInfo(token: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json() as any;
  return data?.result?.url ?? '(none)';
}

(async () => {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`${BOLD}  🔄  BuddyStore Webhook Re-Registration${RST}`);
  console.log(`${'═'.repeat(65)}\n`);

  if (!WEBHOOK_BASE_URL) {
    fail('WEBHOOK_BASE_URL is not set in .env — cannot continue');
    process.exit(1);
  }

  info(`Target base URL: ${WEBHOOK_BASE_URL}`);
  if (WEBHOOK_SECRET) {
    info('Webhook secret token: SET');
  } else {
    warn('WEBHOOK_SECRET not set — webhooks will be unprotected');
  }

  console.log('');

  // ── Category Bots ─────────────────────────────────────────────────────────
  console.log(`${BOLD}Category Bots:${RST}`);
  const bots = await prisma.bot.findMany({ orderBy: { category: 'asc' } });

  let successCount = 0;
  let failCount    = 0;

  for (const bot of bots) {
    if (!bot.token) {
      fail(`[${bot.category}] "${bot.name}" — NO TOKEN in DB, skipping`);
      failCount++;
      continue;
    }

    const slug       = bot.name.replace(/^@/, '').toLowerCase();
    const webhookUrl = `${WEBHOOK_BASE_URL}/webhooks/${slug}`;

    const currentUrl = await getWebhookInfo(bot.token);
    if (currentUrl === webhookUrl) {
      ok(`[${bot.category}] "${bot.name}" already on correct URL — no change needed`);
      successCount++;
      continue;
    }

    info(`[${bot.category}] Current: ${currentUrl}`);
    const success = await setWebhook(bot.token, webhookUrl, bot.category);
    success ? successCount++ : failCount++;
  }

  // ── Special Bot ───────────────────────────────────────────────────────────
  console.log(`\n${BOLD}Special Bot:${RST}`);
  if (!SPECIAL_TOKEN) {
    warn('BOT_SPECIAL_TOKEN not set — skipping BuddySpecial1Bot');
  } else {
    const specialUrl = `${WEBHOOK_BASE_URL}/webhooks/special`;
    const currentUrl = await getWebhookInfo(SPECIAL_TOKEN);
    if (currentUrl === specialUrl) {
      ok(`BuddySpecial1Bot already on correct URL — no change needed`);
      successCount++;
    } else {
      info(`Current: ${currentUrl}`);
      const success = await setWebhook(SPECIAL_TOKEN, specialUrl, 'BuddySpecial1Bot');
      success ? successCount++ : failCount++;
    }
  }

  // ── Main Bot ──────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}Main Bot:${RST}`);
  const MAIN_TOKEN = process.env.MAIN_BOT_TOKEN || '';
  if (!MAIN_TOKEN) {
    warn('MAIN_BOT_TOKEN not set — skipping main bot');
  } else {
    const mainUrl    = `${WEBHOOK_BASE_URL}/webhooks/main`;
    const currentUrl = await getWebhookInfo(MAIN_TOKEN);
    if (currentUrl === mainUrl) {
      ok(`Main bot already on correct URL — no change needed`);
      successCount++;
    } else {
      info(`Current: ${currentUrl}`);
      const success = await setWebhook(MAIN_TOKEN, mainUrl, 'MainBot');
      success ? successCount++ : failCount++;
    }
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`\n  Summary: ${G}${successCount} succeeded${RST}  |  ${failCount > 0 ? R : G}${failCount} failed${RST}\n`);

  if (failCount > 0) {
    warn('Some bots failed. Check the tokens in your DB admin panel and fix the invalid ones.');
  } else {
    ok('All webhooks successfully re-registered!');
    info('Telegram will now deliver all messages to the Railway server.');
    info('Bots should start responding within a few seconds.');
  }

  console.log(`\n${'═'.repeat(65)}\n`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('Fatal error:', e);
  await prisma.$disconnect();
  process.exit(1);
});
