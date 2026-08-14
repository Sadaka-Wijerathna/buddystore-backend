import { Bot, Context } from 'grammy';
import https from 'https';
import prisma from '../lib/prisma';
import config from '../config';
import { uploadThumbnail } from '../lib/cloudinary';

// ─── Global Rate Limiter (Outgoing Sends Only) ────────────────────────────────
// Limits outgoing sendVideo calls in sendVideosToUser to stay under Telegram's
// 30 messages/second global ceiling. Capped at 20/sec to give a generous margin.
//
// NOTE: With webhook mode this limiter is NOT involved in receiving updates — it
// only throttles the outgoing video delivery loop in sendVideosToUser().
//
// Restart-burst fix: tokens start at HALF capacity so a cold-restart scenario
// never immediately fires a full-burst of sends into the same rate window.
const GLOBAL_RATE_LIMIT = 20; // max outgoing messages per second across all bots
let globalTokens = Math.floor(GLOBAL_RATE_LIMIT / 2); // start at half to absorb restart bursts
let lastRefillTime = Date.now();

async function acquireRateToken(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRefillTime;
  if (elapsed >= 1000) {
    globalTokens = GLOBAL_RATE_LIMIT;
    lastRefillTime = now;
  }
  if (globalTokens > 0) {
    globalTokens--;
    return;
  }
  // No tokens left — wait until the next refill window
  const waitMs = 1000 - (Date.now() - lastRefillTime);
  await new Promise((r) => setTimeout(r, Math.max(waitMs, 0)));
  globalTokens = GLOBAL_RATE_LIMIT - 1;
  lastRefillTime = Date.now();
}

// ─── Category Bot Manager ──────────────────────────────────────────────────────
// Manages all category bots. Each bot has collection mode that can be
// toggled by admin. When ON, any video sent to the bot is saved by its file_id.

interface CategoryBotConfig {
  token: string;
  category: string; // Free-form slug, e.g. "MIXED", "TEEN"
  name: string;
}

interface PendingVideo {
  fileId: string;
  telegramUniqueId: string;
  thumbnailFileId?: string;
  mediaType: 'video' | 'photo';
  fileSize?: string;
  duration?: number;
}

export class CategoryBot {
  public bot: Bot | null = null;
  public category: string;
  public name: string;
  public hasToken: boolean;
  private token: string;
  private botDbId: string | null = null;
  
  private cachedBotRecord: any = null;
  private botRecordCacheTime: number = 0;
  private pendingVideoBatch: PendingVideo[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(cfg: CategoryBotConfig) {
    this.category = cfg.category;
    this.name = cfg.name;
    this.hasToken = !!cfg.token;
    this.token = cfg.token;

    if (this.hasToken) {
      this.bot = new Bot(cfg.token);
      
      // Safety: Add global error handler to prevent bot/network errors from crashing the app
      this.bot.catch((err) => {
        console.error(`[${this.name}] ❌ Global Bot Error:`, err);
      });

      this.setupHandlers();
    } else {
      console.warn(`⚠️  ${cfg.name}: No token set — bot not started`);
    }
  }

  private setupHandlers() {
    const bot = this.bot!; // Safe: only called when bot is initialized

    // ── /start — verify BotVerifyToken (checkout flow) ───────────────────
    bot.command('start', async (ctx: Context) => {
      const from = ctx.from;
      if (!from) return;

      const payload = ctx.match as string | undefined; // text after /start

      // If a token payload was sent, it's a checkout verification
      if (payload && payload.length > 8) {
        try {
          const verifyRecord = await prisma.botVerifyToken.findUnique({
            where: { token: payload },
          });

          if (verifyRecord && !verifyRecord.verified && new Date() < verifyRecord.expiresAt) {
            await prisma.botVerifyToken.update({
              where: { token: payload },
              data: { verified: true },
            });
            console.log(`[${this.name}] ✅ Verified token for category ${verifyRecord.category}`);

            await ctx.reply(
              `✅ *${this.name} Verified!*\n\nGo back to the BuddyStore checkout page — it will detect this automatically! 🎉`,
              { parse_mode: 'Markdown' }
            );
            return;
          }
        } catch (e) {
          console.error(`[${this.name}] token verify error:`, e);
        }
      }

      // Regular /start (no payload or unknown payload)
      await ctx.reply(
        `👋 Hello ${from.first_name}! Welcome to *${this.name}*.\n\nVisit BuddyStore to place an order and get videos delivered here! 🎬`,
        { parse_mode: 'Markdown' }
      );
    });

    // Handle videos sent to the bot (only in collection mode)
    bot.on('message:video', async (ctx: Context) => {
      await this.handleVideoMessage(ctx);
    });

    // Handle video notes
    bot.on('message:video_note', async (ctx: Context) => {
      await this.handleVideoNoteMessage(ctx);
    });

    // Handle documents that are videos
    bot.on('message:document', async (ctx: Context) => {
      const doc = ctx.message?.document;
      if (doc && doc.mime_type?.startsWith('video/')) {
        await this.handleDocumentVideoMessage(ctx, doc.file_id, doc.file_unique_id, (doc as any).thumbnail?.file_id);
      }
    });

    // Handle photos sent to the bot (only when collectPhotos is enabled)
    bot.on('message:photo', async (ctx: Context) => {
      await this.handlePhotoMessage(ctx);
    });

    bot.command('status', async (ctx: Context) => {
      const botRecord = await this.getBotRecord();
      if (!botRecord) {
        await ctx.reply('Bot not configured in database.');
        return;
      }
      await ctx.reply(
        `📊 *${this.name} Status*\n\n` +
        `Collection Mode: ${botRecord.collectionMode ? '🟢 ON' : '🔴 OFF'}\n` +
        `Videos: ${botRecord.collectVideos ? '✅ collecting' : '⏸ paused'}\n` +
        `Photos: ${botRecord.collectPhotos ? '✅ collecting' : '⏸ paused'}\n` +
        `Total Media: ${botRecord.totalVideos}`,
        { parse_mode: 'Markdown' }
      );
    });

    // ── Catch-all: record any user who messages this bot ─────────────────
    // This handles users who opened the bot before the /start handler existed
    bot.on('message', async (ctx: Context) => {
      const from = ctx.from;
      if (!from) return;

      const telegramId = String(from.id);

      try {
        const botRecord = await this.getBotRecord();
        if (botRecord && !botRecord.startedUserIds.includes(telegramId)) {
          await prisma.bot.update({
            where: { id: botRecord.id },
            data: { startedUserIds: { push: telegramId } },
          });
          console.log(`[${this.name}] Recorded user ${telegramId} as started`);
        }
      } catch (e) {
        console.error(`[${this.name}] catch-all tracking error:`, e);
      }
    });
  }

  private async handleVideoMessage(ctx: Context) {
    const from = ctx.from?.id ?? 'unknown';
    console.log(`[${this.name}] 📥 Video received from user ${from}`);
    const botRecord = await this.getBotRecord();
    if (!botRecord) {
      console.warn(`[${this.name}] ⚠️ No bot record found in DB — cannot save video`);
      return;
    }
    if (!botRecord.collectionMode) {
      console.log(`[${this.name}] 🔕 Collection mode is OFF — video ignored`);
      return;
    }
    if (!botRecord.collectVideos) {
      console.log(`[${this.name}] 🔕 collectVideos is false — video ignored`);
      return;
    }

    const video = ctx.message?.video;
    if (!video) return;

    const thumbnailFileId = video.thumbnail?.file_id;
    console.log(`[${this.name}] ✅ Queuing video: ${video.file_unique_id}`);
    this.queueMediaSave(video.file_id, video.file_unique_id, botRecord.id, 'video', thumbnailFileId, String(video.file_size || 0), video.duration);
    await ctx.react('👍').catch(() => {});
  }

  private async handleVideoNoteMessage(ctx: Context) {
    console.log(`[${this.name}] 📥 Video note received from user ${ctx.from?.id ?? 'unknown'}`);
    const botRecord = await this.getBotRecord();
    if (!botRecord?.collectionMode || !botRecord.collectVideos) {
      console.log(`[${this.name}] 🔕 Video note ignored (collectionMode=${botRecord?.collectionMode}, collectVideos=${botRecord?.collectVideos})`);
      return;
    }

    const videoNote = ctx.message?.video_note;
    if (!videoNote) return;

    // Video notes don't have thumbnails in the Telegram API
    console.log(`[${this.name}] ✅ Queuing video note: ${videoNote.file_unique_id}`);
    this.queueMediaSave(videoNote.file_id, videoNote.file_unique_id, botRecord.id, 'video', undefined, String(videoNote.file_size || 0), videoNote.duration);
    await ctx.react('👍').catch(() => {});
  }

  private async handleDocumentVideoMessage(ctx: Context, fileId: string, uniqueId: string, thumbnailFileId?: string) {
    console.log(`[${this.name}] 📥 Document-video received from user ${ctx.from?.id ?? 'unknown'}`);
    const botRecord = await this.getBotRecord();
    if (!botRecord?.collectionMode || !botRecord.collectVideos) {
      console.log(`[${this.name}] 🔕 Document-video ignored (collectionMode=${botRecord?.collectionMode}, collectVideos=${botRecord?.collectVideos})`);
      return;
    }

    console.log(`[${this.name}] ✅ Queuing document-video: ${uniqueId}`);
    this.queueMediaSave(fileId, uniqueId, botRecord.id, 'video', thumbnailFileId);
    await ctx.react('👍').catch(() => {});
  }

  private async handlePhotoMessage(ctx: Context) {
    const botRecord = await this.getBotRecord();
    if (!botRecord?.collectionMode || !botRecord.collectPhotos) return;

    // photos come as an array of sizes — pick the largest (last element)
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;
    const largest = photos[photos.length - 1];

    this.queueMediaSave(largest.file_id, largest.file_unique_id, botRecord.id, 'photo', undefined);
    await ctx.react('👍').catch(() => {});
  }

  private queueMediaSave(
    fileId: string, 
    telegramUniqueId: string, 
    botDbId: string, 
    mediaType: 'video' | 'photo', 
    thumbnailFileId?: string,
    fileSize?: string,
    duration?: number
  ) {
    // Deduplicate in memory: if uniqueId already queued, skip
    if (!this.pendingVideoBatch.find(v => v.telegramUniqueId === telegramUniqueId)) {
      this.pendingVideoBatch.push({ fileId, telegramUniqueId, thumbnailFileId, mediaType, fileSize, duration });
    }
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.processVideoBatch(botDbId);
      }, 3000); // Process batch 3 seconds after the first item
    }
  }

  private async processVideoBatch(botDbId: string) {
    this.batchTimer = null;
    const batch = [...this.pendingVideoBatch];
    this.pendingVideoBatch = [];
    
    if (batch.length === 0) return;

    // Deduplicate by telegramUniqueId
    const seen = new Set<string>();
    const uniqueBatch: PendingVideo[] = [];
    for (const item of batch) {
      if (!seen.has(item.telegramUniqueId)) {
        seen.add(item.telegramUniqueId);
        uniqueBatch.push(item);
      }
    }

    try {
      const existing = await prisma.videos.findMany({
        where: { telegramUniqueId: { in: uniqueBatch.map(v => v.telegramUniqueId) } },
        select: { telegramUniqueId: true }
      });
      const existingIds = new Set(existing.map(v => v.telegramUniqueId));

      const newVideos = uniqueBatch.filter(v => !existingIds.has(v.telegramUniqueId));
      
      if (newVideos.length > 0) {
        await prisma.videos.createMany({
          data: newVideos.map(v => ({
            fileId: v.fileId,
            telegramUniqueId: v.telegramUniqueId,
            category: this.category,
            botId: botDbId,
            mediaType: v.mediaType,
            fileSize: v.fileSize,
            duration: v.duration
          })),
          skipDuplicates: true
        });

        await prisma.bot.update({
          where: { id: botDbId },
          data: { totalVideos: { increment: newVideos.length } }
        });

        console.log(`[${this.name}] Batch saved ${newVideos.length} non-duplicate media items.`);

        // ── Async thumbnail upload pass ────────────────────────────────────
        // Download & upload thumbnails to Cloudinary, then update each video's thumbnailUrl.
        // Done asynchronously so it never blocks the collection flow.
        const videosWithThumbnails = newVideos.filter(v => v.thumbnailFileId);
        if (videosWithThumbnails.length > 0 && this.token) {
          this.uploadThumbnailsAsync(videosWithThumbnails);
        }
      }
    } catch (e) {
      console.error(`[${this.name}] Batch save error:`, e);
    }
  }

  // ─── Async thumbnail upload — fire and forget ──────────────────────────────
  private uploadThumbnailsAsync(videos: PendingVideo[]) {
    const CONCURRENCY = 5;
    const queue = [...videos];

    const worker = async () => {
      while (queue.length > 0) {
        const v = queue.shift();
        if (!v || !v.thumbnailFileId) continue;

        try {
          const buffer = await this.downloadTelegramFile(v.thumbnailFileId);
          const url = await uploadThumbnail(buffer, `thumb_${this.category}_${v.fileId.slice(0, 20)}_${Date.now()}`);
          await prisma.videos.updateMany({
            where: { fileId: v.fileId },
            data: { thumbnailUrl: url }
          });
          console.log(`[${this.name}] Thumbnail saved for video ${v.fileId.slice(0, 12)}...`);
        } catch (err) {
          console.error(`[${this.name}] Thumbnail upload failed for ${v.fileId.slice(0, 12)}:`, err);
        }
      }
    };

    // Fire off parallel workers. We don't await because this is a background task.
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
      worker();
    }
  }

  // ─── Download a file from Telegram by file_id ─────────────────────────────
  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    if (!this.bot) throw new Error(`${this.name} has no bot instance`);
    const file = await this.bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;

    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  private async getBotRecord() {
    const now = Date.now();
    if (this.cachedBotRecord && now < this.botRecordCacheTime) {
      return this.cachedBotRecord;
    }
    
    let record;
    if (this.botDbId) {
      record = await prisma.bot.findUnique({ where: { id: this.botDbId } });
    } else {
      record = await prisma.bot.findUnique({ where: { category: this.category } });
    }
    
    if (record) {
      this.botDbId = record.id;
      this.cachedBotRecord = record;
      this.botRecordCacheTime = now + 2000; // 2 seconds cache — fast enough to react to collectionMode toggles
    }
    return record;
  }

  // ─── Send videos to a user for an order ────────────────────────────────────
  // Returns number of successfully sent videos
  async sendVideosToUser(
    orderId: string,
    userId: string,
    userTelegramId: bigint,
    count: number,
    onProgress: (sent: number, total: number) => void
  ): Promise<number> {
    const botRecord = await this.getBotRecord();
    if (!botRecord) throw new Error(`Bot record not found for category: ${this.category}`);

    // Unrecoverable error descriptions — stop entire delivery
    const isUnrecoverable = (desc: string) =>
      desc.includes('chat not found') ||
      desc.includes('bot was blocked by the user') ||
      desc.includes('user is deactivated') ||
      desc.includes('have no rights to send');

    // ── Helper: send a single video with up to 3 retries ─────────────────────
    const trySendSingle = async (fileId: string): Promise<boolean> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (!this.bot) throw new Error(`${this.name} has no token configured`);
          await this.bot.api.sendVideo(userTelegramId.toString(), fileId, {
            protect_content: true,
            disable_notification: true,
          });
          return true;
        } catch (error: any) {
          const description: string = error?.description ?? '';
          const errorCode: number = error?.error_code ?? 0;

          if (isUnrecoverable(description)) {
            try {
              await this.bot?.api.sendMessage(
                userTelegramId.toString(),
                `⚠️ *Order Delivery Failed*\n\nWe couldn't deliver your videos because: _${description}_\n\nPlease contact support and mention your Order ID.`,
                { parse_mode: 'Markdown' }
              );
            } catch (_) { /* ignore if we can't reach the user */ }
            throw new Error(
              `Cannot deliver to Telegram user ${userTelegramId}: ${description}. ` +
              `The user likely never started the bot (@${this.name}).`
            );
          }

          if (errorCode === 429) {
            const retryAfterSec: number = error?.parameters?.retry_after ?? 10;
            console.warn(`[${this.name}] Rate limited (429). Waiting ${retryAfterSec}s before retry...`);
            await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
            continue;
          }

          console.warn(`[${this.name}] Attempt ${attempt}/3 failed: ${description}`);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
        }
      }
      return false;
    };

    // ── Main delivery loop ────────────────────────────────────────────────────
    // NOTE: We always send videos ONE BY ONE using sendVideo, never sendMediaGroup.
    //
    // Reason: sendMediaGroup cannot be safely retried.
    // If Telegram delivers the album but returns a network error to our server,
    // retrying re-sends the same 10 videos = duplicates. sendVideo for a single
    // video is atomic — if it throws, Telegram did NOT deliver it, so retrying
    // is always safe and delivery tracking stays accurate.
    //
    // Get videos that haven't been sent to this user yet for this order
    const videos = await prisma.videos.findMany({
      where: {
        category: this.category,
        videoDeliveries: {
          none: { userId },  // Not already sent to this user
        },
      },
      take: count,
    });

    if (videos.length === 0) {
      throw new Error(`No available videos for category: ${this.category}`);
    }

    let sent = 0;
    // Track IDs of every video we've attempted (for top-up exclusion)
    const attemptedVideoIds = new Set<string>(videos.map(v => v.id));

    for (const video of videos) {
      // ── Idempotency guard: skip if already delivered for this order ────────
      // Protects against re-delivery if processJob is called twice for the
      // same order (e.g. after a server restart or manual admin re-trigger).
      const alreadyDelivered = await prisma.videoDelivery.findFirst({
        where: { orderId, videoId: video.id },
        select: { id: true },
      });
      if (alreadyDelivered) {
        sent++;
        onProgress(sent, count);
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────

      const success = await trySendSingle(video.fileId);

      if (success) {
        await prisma.videoDelivery.createMany({
          data: [{ orderId, videoId: video.id, userId }],
          skipDuplicates: true,
        });
        sent++;
        onProgress(sent, count);
      } else {
        console.error(`[${this.name}] Failed to send video ${video.id} for order ${orderId} after 3 attempts`);
      }

      // Acquire a global rate token (shared across all bots, max 20/sec total outgoing)
      await acquireRateToken();
      await new Promise((r) => setTimeout(r, 1000));
    }

    // ── Top-up loop: compensate for failed sends ──────────────────────────────
    // If some chunks failed, fetch replacement videos from the store (not yet
    // attempted for this user/order) and deliver them to fill the shortfall.
    // Runs up to MAX_TOPUP_PASSES extra passes to avoid an infinite loop when
    // stock is genuinely too low to fulfil the order.
    const MAX_TOPUP_PASSES = 3;
    let topupPass = 0;

    while (sent < count && topupPass < MAX_TOPUP_PASSES) {
      topupPass++;
      const shortfall = count - sent;
      console.log(`[${this.name}] Top-up pass ${topupPass}/${MAX_TOPUP_PASSES}: need ${shortfall} more video(s) for order ${orderId}`);

      const extraVideos = await prisma.videos.findMany({
        where: {
          category: this.category,
          videoDeliveries: { none: { userId } },
          id: { notIn: [...attemptedVideoIds] },
        },
        take: shortfall,
      });

      if (extraVideos.length === 0) {
        console.warn(`[${this.name}] Top-up pass ${topupPass}: no more stock available for order ${orderId}. Stopping.`);
        break;
      }

      for (const v of extraVideos) attemptedVideoIds.add(v.id);

      // Top-up sends are always single-video to maximise success rate
      for (const video of extraVideos) {
        if (sent >= count) break;

        // Idempotency guard: skip if this video was already delivered (retry safety)
        const alreadyDelivered = await prisma.videoDelivery.findFirst({
          where: { orderId, videoId: video.id },
          select: { id: true },
        });
        if (alreadyDelivered) {
          console.log(`[${this.name}] Top-up: video ${video.id} already delivered — skipping`);
          sent++;
          onProgress(sent, count);
          continue;
        }

        const success = await trySendSingle(video.fileId);

        if (success) {
          await prisma.videoDelivery.createMany({
            data: [{ orderId, videoId: video.id, userId }],
            skipDuplicates: true,
          });
          sent++;
          onProgress(sent, count);
        } else {
          console.error(`[${this.name}] Top-up: failed to send video ${video.id} for order ${orderId}`);
        }

        await acquireRateToken();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (sent < count) {
      console.warn(`[${this.name}] Order ${orderId} under-delivered after ${MAX_TOPUP_PASSES} top-up passes: ${sent}/${count}`);
    }

    return sent;
  }

  // ─── Webhook Registration ─────────────────────────────────────────────────
  // Registers this bot's webhook with Telegram. Called once on server startup.
  // No long-polling — Telegram pushes updates to our Express handler.
  async registerWebhook(baseUrl: string, slug: string, secret?: string): Promise<void> {
    if (!this.bot) {
      console.warn(`⚠️  ${this.name}: Skipping webhook registration — no token`);
      return;
    }
    const webhookUrl = `${baseUrl}/webhooks/${slug}`;
    console.log(`🤖 Registering ${this.name} webhook → ${webhookUrl}`);
    try {
      await this.bot.api.setWebhook(webhookUrl, {
        drop_pending_updates: true,
        ...(secret ? { secret_token: secret } : {}),
      });
      console.log(`✅ ${this.name} webhook registered`);
    } catch (err: any) {
      console.error(`❌ ${this.name}: Failed to register webhook — ${err.message}`);
    }
  }

  // ─── Webhook Deregistration ───────────────────────────────────────────────
  async deregisterWebhook(): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: true });
      console.log(`🤖 ${this.name} webhook deregistered`);
    } catch (err: any) {
      console.error(`❌ ${this.name}: Failed to deregister webhook — ${err.message}`);
    }
  }
}

// ─── Bot Registry ──────────────────────────────────────────────────────────────
// Runtime map of category slug → CategoryBot instance.
// Populated from the database (`bots` table).
export const categoryBots: Record<string, CategoryBot> = {};

/**
 * Initialize all category bots from the database at startup.
 */
export async function initCategoryBots(): Promise<void> {
  try {
    const bots = await prisma.bot.findMany({});
    for (const b of bots) {
      if (b.token) {
        categoryBots[b.category] = new CategoryBot({
          token: b.token,
          category: b.category,
          name: b.name,
        });
      }
    }
    console.log(`🤖 Initialized ${Object.keys(categoryBots).length} category bots from database.`);
  } catch (err) {
    console.error('❌ Failed to initialize category bots from database:', err);
  }
}

/**
 * Register or update a CategoryBot at runtime (e.g. when admin creates or edits a category).
 */
export function registerCategoryBot(category: string, token: string, name: string): CategoryBot {
  if (categoryBots[category]) {
    try { categoryBots[category].bot?.stop(); } catch (_) {}
  }
  categoryBots[category] = new CategoryBot({ token, category, name });
  return categoryBots[category];
}

export const registerAllCategoryBotWebhooks = async (baseUrl: string, secret?: string): Promise<void> => {
  if (Object.keys(categoryBots).length === 0) {
    await initCategoryBots();
  }
  for (const [, bot] of Object.entries(categoryBots)) {
    if (bot.hasToken) {
      // Use sanitised bot name as webhook slug (no @ prefix, lowercase)
      const slug = bot.name.replace(/^@/, '').toLowerCase();
      await bot.registerWebhook(baseUrl, slug, secret);
    }
  }
};

export const deregisterAllCategoryBotWebhooks = async (): Promise<void> => {
  console.log('🛑 Deregistering all category bot webhooks...');
  await Promise.all(
    Object.values(categoryBots)
      .filter((bot) => bot.hasToken)
      .map((bot) => bot.deregisterWebhook())
  );
};
