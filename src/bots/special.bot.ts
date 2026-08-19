import { Bot, Context } from 'grammy';
import https from 'https';
import prisma from '../lib/prisma';
import config from '../config';
import { uploadBanner, uploadThumbnail } from '../lib/cloudinary';

// ─── BuddySpecial1Bot ─────────────────────────────────────────────────────────
// Delivers free video collections via Telegram deep links.
//
// Deep link format: https://t.me/BuddySpecial1Bot?start=<slug>
// e.g.  ?start=anu_kanu → sends all SpecialVideos in that collection
//
// Admin collection mode (per collection, toggled from admin panel):
//   When collectionMode is ON for a collection, the admin can send a video
//   with caption #<slug> to this bot and it will be saved.

const specialBotInstance = config.bots.special ? new Bot(config.bots.special) : null;

if (specialBotInstance) {
  // Safety: Add global error handler
  specialBotInstance.catch((err) => {
    console.error('[SpecialBot] ❌ Global Bot Error:', err);
  });
}

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

interface SpecialVideoBatchItem {
  fileId: string;
  telegramUniqueId: string;
  collectionId: string;
  thumbnailFileId?: string;
  mediaType: 'video' | 'image';
}

const specialVideoBatch: SpecialVideoBatchItem[] = [];
let specialBatchTimer: NodeJS.Timeout | null = null;

async function processSpecialVideoBatch() {
  specialBatchTimer = null;
  const queuedVideos = [...specialVideoBatch];
  specialVideoBatch.length = 0; // Clear the queue
  
  if (queuedVideos.length === 0) return;

  // Deduplicate telegramUniqueIds in memory, preserving thumbnailFileId
  const uniqueMap = new Map<string, SpecialVideoBatchItem>();
  for (const v of queuedVideos) {
    if (!uniqueMap.has(v.telegramUniqueId)) {
      uniqueMap.set(v.telegramUniqueId, v);
    }
  }

  const uniqueIdsToCheck = Array.from(uniqueMap.keys());

  try {
    const existing = await prisma.specialVideo.findMany({
      where: { telegramUniqueId: { in: uniqueIdsToCheck } },
      select: { telegramUniqueId: true }
    });
    const existingIds = new Set(existing.map(v => v.telegramUniqueId));

    const newVideos = Array.from(uniqueMap.values())
                           .filter(v => !existingIds.has(v.telegramUniqueId));

    if (newVideos.length > 0) {
      await prisma.specialVideo.createMany({
        data: newVideos.map(v => ({
          fileId: v.fileId,
          telegramUniqueId: v.telegramUniqueId,
          collectionId: v.collectionId,
          mediaType: v.mediaType,
        })),
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
        console.log(`[BuddySpecial1Bot] Batch saved ${count} videos. (Collection ${colId} total: ${total})`);
      }

      // ── Async thumbnail upload pass — fire and forget ──────────────────
      const withThumbnails = newVideos.filter(v => v.thumbnailFileId);
      if (withThumbnails.length > 0 && config.bots.special) {
        uploadSpecialVideoThumbnailsAsync(withThumbnails);
      }
    }
  } catch (e) {
    console.error(`[BuddySpecial1Bot] Batch save error:`, e);
  }
}

// ─── Async thumbnail upload for special videos ───────────────────────────────
function uploadSpecialVideoThumbnailsAsync(videos: SpecialVideoBatchItem[]) {
  Promise.allSettled(
    videos.map(async (v) => {
      try {
        const buffer = await downloadTelegramFile(v.thumbnailFileId!, config.bots.special!);
        const url = await uploadThumbnail(buffer, `thumb_special_${v.fileId.slice(0, 20)}_${Date.now()}`);
        await prisma.specialVideo.updateMany({
          where: { fileId: v.fileId },
          data: { thumbnailUrl: url }
        });
        console.log(`[BuddySpecial1Bot] Thumbnail saved for special video ${v.fileId.slice(0, 12)}...`);
      } catch (err) {
        console.error(`[BuddySpecial1Bot] Thumbnail upload failed for ${v.fileId.slice(0, 12)}:`, err);
      }
    })
  ).catch(() => {});
}

// ─── Helper: save a video/image file_id under a collection (when collectionMode ON) ─
async function queueMediaToCollection(
  ctx: Context,
  fileId: string,
  telegramUniqueId: string,
  mediaType: 'video' | 'image' = 'video',
) {
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

  // Extract per-video thumbnail file_id (not needed for photos)
  const thumbnailFileId = mediaType === 'video'
    ? (ctx.message?.video?.thumbnail?.file_id ||
       (ctx.message?.document as any)?.thumbnail?.file_id)
    : undefined;

  // Push to memory batch
  specialVideoBatch.push({ fileId, telegramUniqueId, collectionId: collection.id, thumbnailFileId, mediaType });
  
  if (!specialBatchTimer) {
    specialBatchTimer = setTimeout(() => {
      processSpecialVideoBatch();
    }, 3000); // Wait 3 seconds to accumulate batch
  }

  // ─── Auto-Banner Feature ───────────────────────────────────────────────────
  // If the collection doesn't have a banner, try to get it from the video thumbnail or photo
  if (!collection.banner) {
    let bannerFileId: string | undefined;

    if (mediaType === 'image') {
      // For photos, use the largest photo size as the banner
      const photos = ctx.message?.photo;
      if (photos && photos.length > 0) {
        bannerFileId = photos[photos.length - 1].file_id;
      }
    } else {
      const thumbnail = ctx.message?.video?.thumbnail ||
                        (ctx.message?.document as any)?.thumbnail;
      if (thumbnail) {
        console.log(`[BuddySpecial1Bot] Processing thumbnail: ${thumbnail.width}x${thumbnail.height}, size: ${thumbnail.file_size}`);
        bannerFileId = thumbnail.file_id;
      }
    }

    if (bannerFileId && config.bots.special) {
      downloadTelegramFile(bannerFileId, config.bots.special)
        .then(async (buffer) => {
          const bannerUrl = await uploadBanner(buffer, `banner_${collection.slug}_${Date.now()}`);
          await prisma.specialCollection.update({
            where: { id: collection.id },
            data: { banner: bannerUrl }
          });
          console.log(`[BuddySpecial1Bot] Auto-set banner for collection: ${collection.title} (${bannerUrl})`);
        })
        .catch(err => console.error(`[BuddySpecial1Bot] Auto-banner failed:`, err));
    }
  }

  await ctx.react('👍').catch(() => {});
}

// Keep old name as alias for backward compat with existing video handlers
const queueVideoToCollection = (ctx: Context, fileId: string, uniqueId: string) =>
  queueMediaToCollection(ctx, fileId, uniqueId, 'video');

if (specialBotInstance) {
  const bot = specialBotInstance;

  // ─── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const slug = (ctx.match as string | undefined)?.trim().toLowerCase();

    // Handle preview video delivery (from the general gallery)
    if (slug && slug.startsWith('preview_')) {
      const videoId = slug.replace('preview_', '').trim();
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
        console.error(`[BuddySpecial1Bot] preview error:`, e);
        await ctx.reply('❌ Something went wrong while retrieving the video.');
      }
      return;
    }

    if (!slug) {
      await ctx.reply(
        `👋 Welcome to *BuddySpecial1Bot*!\n\nUse the special links on BuddyStore to access exclusive video collections. 🎬`,
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

    // Logic to send media is now silent without status messages as requested by user.
    // We run the delivery asynchronously in the background to prevent Telegram webhook timeouts
    // which cause the bot to receive the /start command over and over.
    (async () => {
      let delivered = 0;
      const videos = collection.videos;
      
      // If more than 5 items, send in groups (albums) of up to 10 to speed up delivery and reduce clutter
      const useGroups = videos.length > 5;
      const chunkSize = useGroups ? 10 : 1;

      for (let i = 0; i < videos.length; i += chunkSize) {
        const chunk = videos.slice(i, i + chunkSize);
        
        try {
          if (chunk.length === 1) {
            const v = chunk[0];
            if (v.mediaType === 'image') {
              await bot.api.sendPhoto(from.id, v.fileId);
            } else {
              await bot.api.sendVideo(from.id, v.fileId);
            }
          } else {
            // Group albums (max 10 items)
            const mediaGroup = chunk.map(v => ({
              type: v.mediaType === 'image' ? 'photo' : 'video',
              media: v.fileId
            }));
            await bot.api.sendMediaGroup(from.id, mediaGroup as any);
          }
          
          delivered += chunk.length;
          await new Promise(r => setTimeout(r, useGroups ? 1500 : 1000));
        } catch (err: any) {
          const desc = err?.description || '';
          const code = err?.error_code;
          
          if (code === 403 || code === 400 || desc.includes('blocked') || desc.includes('deactivated') || desc.includes('not found')) {
            console.warn(`[BuddySpecial1Bot] User ${from.id} blocked bot or is deactivated. Aborting delivery.`);
            break; // Stop blasting failing requests to a blocked user
          }
          
          if (code === 429) {
            const retryAfter = err?.parameters?.retry_after || 5;
            console.warn(`[BuddySpecial1Bot] Rate limited (429). Sleeping ${retryAfter}s.`);
            // Step back the loop so we retry this chunk
            i -= chunkSize;
            await new Promise(r => setTimeout(r, retryAfter * 1000));
          } else {
            console.error(`[BuddySpecial1Bot] Failed to send media to ${from.id}:`, err?.message);
          }
        }
      }

      // Clean, simple completion message
      try {
        const msgText = 
  `✅ *That's all from* "${collection.title}"!

  🎬 *${delivered} video${delivered !== 1 ? 's' : ''}* ${delivered !== 1 ? 'have' : 'has'} been delivered to you.
  💾 *Save them now* — they're yours to keep!

  ━━━━━━━━━━━━━━━━━━━
  🔥 *Want more exclusive content?*
  Check out our full store for premium paid collections, trending drops, and free PDFs!

  👉 Visit [BuddyStore](https://buddystore-frontend.vercel.app/)`;

        await bot.api.sendMessage(
          from.id,
          msgText,
          { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
        );
      } catch (err) {
        console.error(`[BuddySpecial1Bot] Failed to send completion message:`, err);
      }
    })();
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
      `📊 *BuddySpecial1Bot Collections*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── Video/Image upload (collection mode must be ON for the tagged collection) ────
  bot.on('message:video', async (ctx: Context) => {
    const fileId = ctx.message?.video?.file_id;
    const uniqueId = ctx.message?.video?.file_unique_id;
    if (fileId && uniqueId) await queueVideoToCollection(ctx, fileId, uniqueId);
  });

  bot.on('message:video_note', async (ctx: Context) => {
    const fileId = ctx.message?.video_note?.file_id;
    const uniqueId = ctx.message?.video_note?.file_unique_id;
    if (fileId && uniqueId) await queueVideoToCollection(ctx, fileId, uniqueId);
  });

  bot.on('message:document', async (ctx: Context) => {
    const doc = ctx.message?.document;
    if (doc?.mime_type?.startsWith('video/')) {
      await queueVideoToCollection(ctx, doc.file_id, doc.file_unique_id);
    } else if (doc?.mime_type?.startsWith('image/')) {
      await queueMediaToCollection(ctx, doc.file_id, doc.file_unique_id, 'image');
    }
  });

  // ─── Photo upload ─────────────────────────────────────────────────────────
  bot.on('message:photo', async (ctx: Context) => {
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;
    // Use the highest-resolution version (last in array)
    const photo = photos[photos.length - 1];
    await queueMediaToCollection(ctx, photo.file_id, photo.file_unique_id, 'image');
  });

  // ─── Catch-all ─────────────────────────────────────────────────────────────
  bot.on('message', async (ctx: Context) => {
    await ctx.reply(
      `👋 Use the special links on *BuddyStore* to access video collections!\n\nVisit: https://buddystore-frontend.vercel.app`,
      { parse_mode: 'Markdown' }
    );
  });
}

// ─── Webhook Registration ─────────────────────────────────────────────────────
export const registerSpecialBotWebhook = async (baseUrl: string, secret?: string): Promise<void> => {
  if (!specialBotInstance) {
    console.warn('⚠️  BOT_SPECIAL_TOKEN not set — BuddySpecial1Bot webhook not registered');
    return;
  }
  const webhookUrl = `${baseUrl}/webhooks/special`;
  console.log(`🤖 Registering BuddySpecial1Bot webhook → ${webhookUrl}`);
  try {
    await specialBotInstance.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      ...(secret ? { secret_token: secret } : {}),
    });
    console.log('✅ BuddySpecial1Bot webhook registered');
  } catch (err: any) {
    console.error(`❌ BuddySpecial1Bot: Failed to register webhook — ${err.message}`);
  }
};

// ─── Webhook Deregistration ───────────────────────────────────────────────────
export const deregisterSpecialBotWebhook = async (): Promise<void> => {
  if (!specialBotInstance) return;
  try {
    await specialBotInstance.api.deleteWebhook({ drop_pending_updates: true });
    console.log('🤖 BuddySpecial1Bot webhook deregistered');
  } catch (err: any) {
    console.error(`❌ BuddySpecial1Bot: Failed to deregister webhook — ${err.message}`);
  }
};
