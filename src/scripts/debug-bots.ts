/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  DEBUG SCRIPT — Bot Collection Mode & Webhook Diagnostics            ║
 * ║                                                                      ║
 * ║  Run with:  npx ts-node -r dotenv/config src/scripts/debug-bots.ts  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * This script diagnoses WHY bots don't grab videos in collection mode.
 * It checks:
 *   1. Bots in DB — tokens present, collectionMode flag
 *   2. Webhook info per bot — what Telegram thinks is registered
 *   3. Webhook URL consistency — does the registered URL match WEBHOOK_BASE_URL?
 *   4. Special bot (BOT_SPECIAL_TOKEN) — still using ENV
 *   5. Special collections — collectionMode on any?
 *   6. DB video count sanity check
 */

import 'dotenv/config';
import prisma from '../lib/prisma';

const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
const SPECIAL_TOKEN    = process.env.BOT_SPECIAL_TOKEN || '';

// ─── ANSI colours ──────────────────────────────────────────────────────────────
const G    = '\x1b[32m';
const R    = '\x1b[31m';
const Y    = '\x1b[33m';
const B    = '\x1b[36m';
const DIM  = '\x1b[2m';
const RST  = '\x1b[0m';
const BOLD = '\x1b[1m';

function ok(msg: string)   { console.log(`${G}  ✅  ${msg}${RST}`); }
function fail(msg: string) { console.log(`${R}  ❌  ${msg}${RST}`); }
function warn(msg: string) { console.log(`${Y}  ⚠️   ${msg}${RST}`); }
function info(msg: string) { console.log(`${B}  ℹ️   ${msg}${RST}`); }
function head(msg: string) { console.log(`\n${BOLD}${msg}${RST}`); }

async function telegramGet(token: string, method: string): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`);
  return res.json();
}

(async () => {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`${BOLD}  🔍  BuddyStore Bot Collection Diagnostics${RST}`);
  console.log(`${'═'.repeat(65)}`);

  // ── 1. Environment ───────────────────────────────────────────────────────
  head('1. Environment Variables');
  if (WEBHOOK_BASE_URL) {
    ok(`WEBHOOK_BASE_URL = ${WEBHOOK_BASE_URL}`);
  } else {
    fail('WEBHOOK_BASE_URL is NOT set — Telegram cannot reach your server, bots are dead!');
  }

  if (SPECIAL_TOKEN) {
    ok('BOT_SPECIAL_TOKEN is set in ENV (used by special bot)');
  } else {
    warn('BOT_SPECIAL_TOKEN not in ENV — BuddySpecial1Bot is disabled');
  }

  // ── 2. Category bots from DB ─────────────────────────────────────────────
  head('2. Category Bots (from Database)');
  const bots = await prisma.bot.findMany({ orderBy: { category: 'asc' } });

  if (bots.length === 0) {
    fail('No bots found in the database! Migration from ENV tokens may have not been completed.');
  } else {
    console.log(`\n  Found ${bots.length} bot(s) in DB:\n`);
    for (const bot of bots) {
      const hasToken = !!bot.token;
      const slug = (bot.name || '').replace(/^@/, '').toLowerCase();
      const expectedUrl = `${WEBHOOK_BASE_URL}/webhooks/${slug}`;

      console.log(`  ${BOLD}──── [${bot.category}]  "${bot.name}" ────${RST}`);
      hasToken ? ok(`Token: stored in DB`) : fail(`Token: MISSING in DB — bot cannot be initialised!`);
      bot.collectionMode ? ok(`Collection mode: ON`) : warn(`Collection mode: OFF — videos will NOT be saved`);
      info(`collectVideos=${bot.collectVideos}  collectPhotos=${bot.collectPhotos}`);
      info(`Videos stored in DB: ${bot.totalVideos}`);
      info(`Expected webhook URL: ${expectedUrl}`);

      if (hasToken) {
        try {
          const wh = await telegramGet(bot.token!, 'getWebhookInfo');
          if (!wh.ok) {
            fail(`Telegram API rejected token: ${wh.description}`);
          } else {
            const registered   = wh.result?.url || '';
            const pending      = wh.result?.pending_update_count ?? 0;
            const lastErr      = wh.result?.last_error_message || null;
            const lastErrDate  = wh.result?.last_error_date || null;

            if (!registered) {
              fail('Webhook NOT registered with Telegram — no updates will ever arrive!');
              info(`Fix: call bot.api.setWebhook("${expectedUrl}") — or restart the backend with WEBHOOK_BASE_URL set`);
            } else if (registered !== expectedUrl) {
              warn('Webhook URL MISMATCH:');
              warn(`  Telegram has: ${registered}`);
              warn(`  We expect:    ${expectedUrl}`);
              info('This means Telegram is sending updates to the OLD URL — may be dev vs prod mismatch');
            } else {
              ok(`Webhook correctly registered: ${registered}`);
            }

            if (pending > 0) {
              warn(`${pending} pending update(s) queued at Telegram — webhook may be failing or slow`);
            }

            if (lastErr) {
              const d = lastErrDate ? new Date(lastErrDate * 1000).toISOString() : 'unknown time';
              fail(`Last webhook delivery error (at ${d}): "${lastErr}"`);
            } else if (registered) {
              ok('No recent webhook errors from Telegram');
            }
          }
        } catch (e: any) {
          fail(`Could not reach Telegram API: ${e.message}`);
        }
      }
      console.log();
    }
  }

  // ── 3. Special bot ────────────────────────────────────────────────────────
  head('3. BuddySpecial1Bot (Trending / Special Collections)');
  if (SPECIAL_TOKEN) {
    const expectedSpecialUrl = `${WEBHOOK_BASE_URL}/webhooks/special`;
    info(`Expected webhook URL: ${expectedSpecialUrl}`);
    try {
      const wh = await telegramGet(SPECIAL_TOKEN, 'getWebhookInfo');
      if (!wh.ok) {
        fail(`Telegram API error for special bot: ${wh.description}`);
      } else {
        const registered  = wh.result?.url || '';
        const pending     = wh.result?.pending_update_count ?? 0;
        const lastErr     = wh.result?.last_error_message || null;
        const lastErrDate = wh.result?.last_error_date || null;

        if (!registered) {
          fail('Special bot webhook NOT registered! /dashboard/trending-videos collection cannot work.');
        } else if (registered !== expectedSpecialUrl) {
          warn(`Webhook MISMATCH for special bot:`);
          warn(`  Registered: ${registered}`);
          warn(`  Expected:   ${expectedSpecialUrl}`);
        } else {
          ok(`Special bot webhook: ${registered}`);
        }

        if (pending > 0) warn(`${pending} pending update(s) for special bot`);
        if (lastErr) {
          const d = lastErrDate ? new Date(lastErrDate * 1000).toISOString() : 'unknown time';
          fail(`Special bot last webhook error (at ${d}): "${lastErr}"`);
        } else if (registered) {
          ok('No recent errors for special bot');
        }
      }
    } catch (e: any) {
      fail(`Could not reach Telegram API: ${e.message}`);
    }
  } else {
    warn('BOT_SPECIAL_TOKEN not set — skipping special bot webhook check');
  }

  // ── 4. Special collections ────────────────────────────────────────────────
  head('4. Special Collections (Trending Videos Page data)');
  const collections = await prisma.specialCollection.findMany({ orderBy: { createdAt: 'desc' } });
  if (collections.length === 0) {
    warn('No special collections in DB — /dashboard/trending-videos will show empty grid');
    info('Create collections via: Admin → Trending Collections');
  } else {
    console.log(`  Found ${collections.length} collection(s):\n`);
    for (const c of collections) {
      console.log(`  ${BOLD}[${c.slug}]${RST}  "${c.title}"  (${c.totalVideos} videos)`);
      c.collectionMode
        ? ok(`Collection mode ON — videos tagged #${c.slug} will be saved`)
        : info(`Collection mode OFF`);
      c.banner ? ok('Has banner image') : warn('No banner — collection will show placeholder icon');
      console.log();
    }
  }

  // ── 5. DB video counts ────────────────────────────────────────────────────
  head('5. Database Video Counts');
  const [catCount, specialCount] = await Promise.all([
    prisma.videos.count(),
    prisma.specialVideo.count(),
  ]);
  info(`Category videos:        ${catCount}`);
  info(`Special/trending videos: ${specialCount}`);

  if (catCount === 0) {
    warn('Zero category videos — collection has never worked, OR DB was cleared after migration');
  }
  if (specialCount === 0) {
    warn('Zero special videos — trending collections are all empty');
  }

  // ── 6. Root cause summary ─────────────────────────────────────────────────
  head('6. Root Cause Summary');

  const noToken  = bots.filter(b => !b.token);
  const modeOff  = bots.filter(b => b.token && !b.collectionMode);

  if (noToken.length > 0) {
    fail(`${noToken.length} bot(s) have NO token: ${noToken.map(b => b.category).join(', ')}`);
    info('Fix: Go to Admin → Categories → edit the bot and enter the Telegram bot token');
  }

  if (modeOff.length > 0 && catCount === 0) {
    warn(`${modeOff.length} bot(s) have tokens but collection mode is OFF: ${modeOff.map(b => b.category).join(', ')}`);
    info('Fix: Toggle collection mode ON from Admin → Categories');
  }

  if (!WEBHOOK_BASE_URL) {
    fail('CRITICAL: WEBHOOK_BASE_URL is not set — no bot can receive any message from Telegram');
    info('Fix: Set WEBHOOK_BASE_URL=https://your-server.onrender.com in the environment, then restart');
  }

  console.log(`\n${'═'.repeat(65)}\n`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('Fatal diagnostic error:', e);
  await prisma.$disconnect();
  process.exit(1);
});
