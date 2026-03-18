import { Bot, Context } from 'grammy';
import https from 'https';
import prisma from '../lib/prisma';
import config from '../config';
import { uploadBanner } from '../lib/cloudinary';

// ─── BuddySpecialBot ──────────────────────────────────────────────────────────
// Delivers free video collections via Telegram deep links.
//
// Deep link format: https://t.me/BuddySpecialBot?start=<slug>
// e.g.  ?start=anu_kanu → sends all SpecialVideos in that collection
//
// Admin collection mode (per collection, toggled from admin panel):
//   When collectionMode is ON for a collection, the admin can send a video
//   with caption #<slug> to this bot and it will be saved.

const specialBotInstance = config.bots.special ? new Bot(config.bots.special) : null;

export const specialBot = specialBotInstance;

// ─── Helper: get collection record from DB ───────────────────────────────────
async function getCollection(slug: string) {
  return prisma.specialCollection.findUnique({
    where: { slug },
    include: { videos: true },
  });
}

// ─── Helper: extract #slug from caption ──────────────────────────────────────
function extractSlug(caption: string | undefined): string | null {
  if (!caption) return null;
  const match = caption.match(/#([a-z0-9_]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// ─── Helper: download file from Telegram ─────────────────────────────────────
async function downloadTelegramFile(fileId: string, token: string): Promise<Buffer> {
  const bot = specialBotInstance;
  if (!bot) throw new Error('Bot instance not initialized');

  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: any[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (err) => reject(err));
    }).on('error', (err) => reject(err));
  });
}

const specialVideoBatch: { fileId: string; collectionId: string }[] = [];
let specialBatchTimer: NodeJS.Timeout | null = null;

async function processSpecialVideoBatch() {
  specialBatchTimer = null;
  const queuedVideos = [...specialVideoBatch];
  specialVideoBatch.length = 0; // Clear the queue
  
  if (queuedVideos.length === 0) return;

  // Deduplicate fileIds in memory
  const uniqueFileIds = new Map<string, string>();
  for (const v of queuedVideos) {
    if (!uniqueFileIds.has(v.fileId)) {
      uniqueFileIds.set(v.fileId, v.collectionId);
    }
  }

  const fileIdsToCheck = Array.from(uniqueFileIds.keys());

  try {
    const existing = await prisma.specialVideo.findMany({
      where: { fileId: { in: fileIdsToCheck } },
      select: { fileId: true }
    });
    const existingIds = new Set(existing.map(v => v.fileId));

    const newVideos = Array.from(uniqueFileIds.entries())
                           .filter(([fileId]) => !existingIds.has(fileId))
                           .map(([fileId, collectionId]) => ({ fileId, collectionId }));

    if (newVideos.length > 0) {
      await prisma.specialVideo.createMany({
        data: newVideos,
        skipDuplicates: true
      });

      // Update total videos count per collection
      const collectionCounts = newVideos.reduce((acc, curr) => {
        acc[curr.collectionId] = (acc[curr.collectionId] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      for (const [colId, count] of Object.entries(collectionCounts)) {
        await prisma.specialCollection.update({
          where: { id: colId },
          data: { totalVideos: { increment: count } }
        });
        const total = await prisma.specialVideo.count({ where: { collectionId: colId } });
        console.log(`[BuddySpecialBot] Batch saved ${count} videos. (Collection ${colId} total: ${total})`);
      }
    }
  } catch (e) {
    console.error(`[BuddySpecialBot] Batch save error:`, e);
  }
}

// ─── Helper: save a video file_id under a collection (when collectionMode ON) ─
async function queueVideoToCollection(ctx: Context, fileId: string) {
  const caption = ctx.message?.caption;
  const slug = extractSlug(caption);

  let collection;

  if (slug) {
    // If they explicitly provided a #slug, use that collection
    collection = await prisma.specialCollection.findUnique({ where: { slug } });
    if (!collection) {
      // Don't reply on every single video in a batch of 500
      return;
    }
    if (!collection.collectionMode) {
      return;
    }
  } else {
    // If no #slug is provided, look for any collection that currently has collectionMode = true
    const activeCollections = await prisma.specialCollection.findMany({
      where: { collectionMode: true },
    });

    if (activeCollections.length === 0) return;
    if (activeCollections.length > 1) return; // Need explicit slug if >1

    // Exactly one collection is active, so we use it automatically
    collection = activeCollections[0];
  }

  // Push to memory batch
  specialVideoBatch.push({ fileId, collectionId: collection.id });
  
  if (!specialBatchTimer) {
    specialBatchTimer = setTimeout(() => {
      processSpecialVideoBatch();
    }, 3000); // Wait 3 seconds to accumulate batch
  }

  // ─── Auto-Banner Feature ───────────────────────────────────────────────────
  // If the collection doesn't have a banner image, try to get it from the video thumbnail
  if (!collection.banner) {
    const thumbnail = ctx.message?.video?.thumbnail || 
                      (ctx.message?.document as any)?.thumbnail;
                      
    if (thumbnail && config.bots.special) {
      console.log(`[BuddySpecialBot] Processing thumbnail: ${thumbnail.width}x${thumbnail.height}, size: ${thumbnail.file_size}`);
      downloadTelegramFile(thumbnail.file_id, config.bots.special)
        .then(async (buffer) => {
          const bannerUrl = await uploadBanner(buffer, `banner_${collection.slug}_${Date.now()}`);
          await prisma.specialCollection.update({
            where: { id: collection.id },
            data: { banner: bannerUrl }
          });
          console.log(`[BuddySpecialBot] Auto-set banner for collection: ${collection.title} (${bannerUrl})`);
        })
        .catch(err => console.error(`[BuddySpecialBot] Auto-banner failed:`, err));
    }
  }

  await ctx.react('👍').catch(() => {});
}

if (specialBotInstance) {
  const bot = specialBotInstance;

  // ─── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const slug = (ctx.match as string | undefined)?.trim().toLowerCase();

    if (!slug) {
      await ctx.reply(
        `👋 Welcome to *BuddySpecialBot*!\n\nUse the special links on BuddyStore to access exclusive video collections. 🎬`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const collection = await getCollection(slug);

    if (!collection) {
      await ctx.reply(`❌ Collection not found or not available.`);
      return;
    }

    if (collection.videos.length === 0) {
      await ctx.reply(`⚠️ *${collection.title}* has no videos yet. Check back soon!`, { parse_mode: 'Markdown' });
      return;
    }

    // Logic to send videos is now silent without status messages as requested by user.
    for (const video of collection.videos) {
      try {
        await bot.api.sendVideo(from.id, video.fileId);
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.error(`[BuddySpecialBot] Failed to send video ${video.fileId}:`, err);
      }
    }
  });

  // ─── /status — shows all collections and their video counts ────────────────
  bot.command('status', async (ctx: Context) => {
    const collections = await prisma.specialCollection.findMany({
      include: { _count: { select: { videos: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (collections.length === 0) {
      await ctx.reply('No collections found. Create them via the admin panel.');
      return;
    }

    const lines = collections.map((c: any) =>
      `${c.collectionMode ? '🟢' : '🔴'} *${c.title}* (\`${c.slug}\`) — ${c._count.videos} video(s)`
    );

    await ctx.reply(
      `📊 *BuddySpecialBot Collections*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── Video upload (collection mode must be ON for the tagged collection) ────
  bot.on('message:video', async (ctx: Context) => {
    const fileId = ctx.message?.video?.file_id;
    if (fileId) await queueVideoToCollection(ctx, fileId);
  });

  bot.on('message:video_note', async (ctx: Context) => {
    const fileId = ctx.message?.video_note?.file_id;
    if (fileId) await queueVideoToCollection(ctx, fileId);
  });

  bot.on('message:document', async (ctx: Context) => {
    const doc = ctx.message?.document;
    if (doc?.mime_type?.startsWith('video/')) {
      await queueVideoToCollection(ctx, doc.file_id);
    }
  });

  // ─── Catch-all ─────────────────────────────────────────────────────────────
  bot.on('message', async (ctx: Context) => {
    await ctx.reply(
      `👋 Use the special links on *BuddyStore* to access video collections!\n\nVisit: https://buddystore-frontend.vercel.app`,
      { parse_mode: 'Markdown' }
    );
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────
export const startSpecialBot = () => {
  if (!specialBotInstance) {
    console.warn('⚠️  BOT_SPECIAL_TOKEN not set — BuddySpecialBot not started');
    return;
  }
  specialBotInstance.start({
    onStart: (info) => {
      console.log(`✅ BuddySpecialBot started: @${info.username}`);
    },
  }).catch((err: Error) => {
    console.error(`❌ BuddySpecialBot: Failed to start — ${err.message}`);
  });
};

// Stop
export const stopSpecialBot = async () => {
  if (specialBotInstance && specialBotInstance.isInited()) {
    console.log('🛑 Stopping BuddySpecialBot...');
    await specialBotInstance.stop();
  }
};
