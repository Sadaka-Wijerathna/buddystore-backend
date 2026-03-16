import { Bot, Context } from 'grammy';
import prisma from '../lib/prisma';
import config from '../config';

// ─── BuddySpecialBot ──────────────────────────────────────────────────────────
// Delivers free video collections via Telegram deep links.
//
// Deep link format: https://t.me/BuddySpecialBot?start=<slug>
// e.g.  ?start=anu_kanu  →  sends all SpecialVideos in the "anu_kanu" collection
//
// Admin collection mode:
//   Send a video/document to this bot with caption #<slug> (e.g. #anu_kanu)
//   Bot will save that file_id to the matching SpecialCollection.
//   Admin is identified by BOT_SPECIAL_ADMIN_ID (numeric Telegram user ID).

export const specialBot = new Bot(config.bots.special);

const ADMIN_ID = config.bots.specialAdminId ? Number(config.bots.specialAdminId) : null;

// ─── Helper: is the sender the admin? ────────────────────────────────────────
function isAdmin(ctx: Context): boolean {
  if (!ADMIN_ID) return false;
  return ctx.from?.id === ADMIN_ID;
}

// ─── Helper: extract #slug from caption ──────────────────────────────────────
function extractSlug(caption: string | undefined): string | null {
  if (!caption) return null;
  const match = caption.match(/#([a-z0-9_]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// ─── Helper: save a video file_id under a collection slug ────────────────────
async function saveVideoToCollection(ctx: Context, fileId: string) {
  if (!isAdmin(ctx)) return;

  const caption = ctx.message?.caption;
  const slug = extractSlug(caption);

  if (!slug) {
    await ctx.reply('⚠️ No collection tag found. Send a video with caption #slug (e.g. #anu_kanu).');
    return;
  }

  const collection = await prisma.specialCollection.findUnique({ where: { slug } });
  if (!collection) {
    await ctx.reply(`❌ Collection *${slug}* not found. Create it in the admin panel first.`, { parse_mode: 'Markdown' });
    return;
  }

  // Avoid duplicates
  const existing = await prisma.specialVideo.findUnique({ where: { fileId } });
  if (existing) {
    await ctx.reply(`⚠️ Video already saved to *${collection.title}*.`, { parse_mode: 'Markdown' });
    return;
  }

  await prisma.specialVideo.create({
    data: { fileId, collectionId: collection.id },
  });

  const total = await prisma.specialVideo.count({ where: { collectionId: collection.id } });
  console.log(`[BuddySpecialBot] Saved video to "${collection.title}" (total: ${total})`);
  await ctx.react('👍');
}

// ─── /start ──────────────────────────────────────────────────────────────────
specialBot.command('start', async (ctx: Context) => {
  const from = ctx.from;
  if (!from) return;

  const slug = (ctx.match as string | undefined)?.trim().toLowerCase();

  // No payload — welcome message
  if (!slug) {
    await ctx.reply(
      `👋 Welcome to *BuddySpecialBot*!\n\nUse the special links on BuddyStore to access exclusive video collections. 🎬`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Find collection
  const collection = await prisma.specialCollection.findUnique({
    where: { slug },
    include: { videos: true },
  });

  if (!collection || !collection.active) {
    await ctx.reply(`❌ Collection not found or not available.`);
    return;
  }

  if (collection.videos.length === 0) {
    await ctx.reply(`⚠️ *${collection.title}* has no videos yet. Check back soon!`, { parse_mode: 'Markdown' });
    return;
  }

  // Send intro message
  await ctx.reply(
    `🎬 *${collection.title}*\n\n${collection.description || 'Sending your videos now...'}\n\n📤 Sending ${collection.videos.length} video(s)...`,
    { parse_mode: 'Markdown' }
  );

  // Send each video
  let sent = 0;
  for (const video of collection.videos) {
    try {
      await specialBot.api.sendVideo(from.id, video.fileId);
      sent++;
      // Rate limit: 1 per second to stay safe with Telegram
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[BuddySpecialBot] Failed to send video ${video.fileId}:`, err);
    }
  }

  await ctx.reply(`✅ Done! Sent ${sent}/${collection.videos.length} video(s) from *${collection.title}*. Enjoy! 🎉`, { parse_mode: 'Markdown' });
  console.log(`[BuddySpecialBot] Sent ${sent} videos from "${slug}" to user ${from.id}`);
});

// ─── /status — admin only ────────────────────────────────────────────────────
specialBot.command('status', async (ctx: Context) => {
  if (!isAdmin(ctx)) {
    await ctx.reply('⛔ Admin only command.');
    return;
  }

  const collections = await prisma.specialCollection.findMany({
    include: { _count: { select: { videos: true } } },
    orderBy: { createdAt: 'asc' },
  });

  if (collections.length === 0) {
    await ctx.reply('No collections found. Create them via the admin panel.');
    return;
  }

  const lines = collections.map(c =>
    `${c.active ? '🟢' : '🔴'} *${c.title}* (\`${c.slug}\`) — ${c._count.videos} video(s)`
  );

  await ctx.reply(
    `📊 *BuddySpecialBot Collections*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Video upload (admin collection mode) ────────────────────────────────────
specialBot.on('message:video', async (ctx: Context) => {
  const fileId = ctx.message?.video?.file_id;
  if (fileId) await saveVideoToCollection(ctx, fileId);
});

specialBot.on('message:video_note', async (ctx: Context) => {
  const fileId = ctx.message?.video_note?.file_id;
  if (fileId) await saveVideoToCollection(ctx, fileId);
});

specialBot.on('message:document', async (ctx: Context) => {
  const doc = ctx.message?.document;
  if (doc?.mime_type?.startsWith('video/')) {
    await saveVideoToCollection(ctx, doc.file_id);
  }
});

// ─── Catch-all for non-admin users ───────────────────────────────────────────
specialBot.on('message', async (ctx: Context) => {
  if (isAdmin(ctx)) return; // Admin messages handled above
  await ctx.reply(
    `👋 Use the special links on *BuddyStore* to access video collections!\n\nVisit: https://buddystore-frontend.vercel.app`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Start ───────────────────────────────────────────────────────────────────
export const startSpecialBot = () => {
  if (!config.bots.special) {
    console.warn('⚠️  BOT_SPECIAL_TOKEN not set — BuddySpecialBot not started');
    return;
  }
  specialBot.start({
    onStart: (info) => {
      console.log(`✅ BuddySpecialBot started: @${info.username}`);
    },
  }).catch((err: Error) => {
    console.error(`❌ BuddySpecialBot: Failed to start — ${err.message}`);
  });
};
