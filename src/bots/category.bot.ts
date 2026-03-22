import { Bot, Context } from 'grammy';
import https from 'https';
import { Category } from '@prisma/client';
import prisma from '../lib/prisma';
import config from '../config';
import { uploadThumbnail } from '../lib/cloudinary';

// ─── Category Bot Manager ──────────────────────────────────────────────────────
// Manages all 6 category bots. Each bot has collection mode that can be
// toggled by admin. When ON, any video sent to the bot is saved by its file_id.

interface CategoryBotConfig {
  token: string;
  category: Category;
  name: string;
}

interface PendingVideo {
  fileId: string;
  thumbnailFileId?: string;
}

export class CategoryBot {
  public bot: Bot | null = null;
  public category: Category;
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
        await this.handleDocumentVideoMessage(ctx, doc.file_id, (doc as any).thumbnail?.file_id);
      }
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
        `Total Videos: ${botRecord.totalVideos}`,
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
    const botRecord = await this.getBotRecord();
    if (!botRecord?.collectionMode) return; // Ignore if collection mode is off

    const video = ctx.message?.video;
    if (!video) return;

    const thumbnailFileId = video.thumbnail?.file_id;
    this.queueVideoSave(video.file_id, botRecord.id, thumbnailFileId);
    await ctx.react('👍').catch(() => {});
  }

  private async handleVideoNoteMessage(ctx: Context) {
    const botRecord = await this.getBotRecord();
    if (!botRecord?.collectionMode) return;

    const videoNote = ctx.message?.video_note;
    if (!videoNote) return;

    // Video notes don't have thumbnails in the Telegram API
    this.queueVideoSave(videoNote.file_id, botRecord.id, undefined);
    await ctx.react('👍').catch(() => {});
  }

  private async handleDocumentVideoMessage(ctx: Context, fileId: string, thumbnailFileId?: string) {
    const botRecord = await this.getBotRecord();
    if (!botRecord?.collectionMode) return;

    this.queueVideoSave(fileId, botRecord.id, thumbnailFileId);
    await ctx.react('👍').catch(() => {});
  }

  private queueVideoSave(fileId: string, botDbId: string, thumbnailFileId?: string) {
    // Deduplicate in memory: if fileId already queued, skip
    if (!this.pendingVideoBatch.find(v => v.fileId === fileId)) {
      this.pendingVideoBatch.push({ fileId, thumbnailFileId });
    }
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.processVideoBatch(botDbId);
      }, 3000); // Process batch 3 seconds after the first video
    }
  }

  private async processVideoBatch(botDbId: string) {
    this.batchTimer = null;
    const batch = [...this.pendingVideoBatch];
    this.pendingVideoBatch = [];
    
    if (batch.length === 0) return;

    // Deduplicate by fileId
    const seen = new Set<string>();
    const uniqueBatch: PendingVideo[] = [];
    for (const item of batch) {
      if (!seen.has(item.fileId)) {
        seen.add(item.fileId);
        uniqueBatch.push(item);
      }
    }

    try {
      const existing = await prisma.videos.findMany({
        where: { fileId: { in: uniqueBatch.map(v => v.fileId) } },
        select: { fileId: true }
      });
      const existingIds = new Set(existing.map(v => v.fileId));

      const newVideos = uniqueBatch.filter(v => !existingIds.has(v.fileId));
      
      if (newVideos.length > 0) {
        await prisma.videos.createMany({
          data: newVideos.map(v => ({
            fileId: v.fileId,
            category: this.category,
            botId: botDbId
          })),
          skipDuplicates: true
        });

        await prisma.bot.update({
          where: { id: botDbId },
          data: { totalVideos: { increment: newVideos.length } }
        });

        console.log(`[${this.name}] Batch saved ${newVideos.length} non-duplicate videos.`);

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
    Promise.allSettled(
      videos.map(async (v) => {
        try {
          const buffer = await this.downloadTelegramFile(v.thumbnailFileId!);
          const url = await uploadThumbnail(buffer, `thumb_${this.category}_${v.fileId.slice(0, 20)}_${Date.now()}`);
          await prisma.videos.updateMany({
            where: { fileId: v.fileId },
            data: { thumbnailUrl: url }
          });
          console.log(`[${this.name}] Thumbnail saved for video ${v.fileId.slice(0, 12)}...`);
        } catch (err) {
          console.error(`[${this.name}] Thumbnail upload failed for ${v.fileId.slice(0, 12)}:`, err);
        }
      })
    ).catch(() => {}); // swallow any outer errors
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
      this.botRecordCacheTime = now + 10000; // 10 seconds cache
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

    // Get videos that haven't been sent to this user yet
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

    for (const video of videos) {
      try {
        // Send the video using its stored file_id
        if (!this.bot) throw new Error(`${this.name} has no token configured`);
        await this.bot.api.sendVideo(Number(userTelegramId), video.fileId);

        // Record the delivery
        await prisma.videoDelivery.create({
          data: {
            orderId,
            videoId: video.id,
            userId,
          },
        });

        sent++;
        onProgress(sent, videos.length);

        // Rate limiting: Telegram allows ~30 msgs/sec per bot
        // For safety, we send 1 per second to avoid bans
        await new Promise((r) => setTimeout(r, 1000));
      } catch (error) {
        console.error(`[${this.name}] Failed to send video ${video.fileId}:`, error);
        // Continue with next video even if one fails
      }
    }

    return sent;
  }

  start() {
    if (!this.bot) {
      console.warn(`⚠️  ${this.name}: Skipping start — no token`);
      return;
    }
    this.bot.start({
      onStart: (info) => {
        console.log(`✅ ${this.name} started: @${info.username}`);
      },
    }).catch((err: Error) => {
      console.error(`❌ ${this.name}: Failed to start — ${err.message}. Check BOT token in environment variables.`);
    });
  }

  async stop() {
    if (this.bot && this.bot.isInited()) {
      console.log(`🛑 Stopping ${this.name}...`);
      await this.bot.stop();
    }
  }
}

// ─── Bot Registry ──────────────────────────────────────────────────────────────

export const categoryBots: Record<Category, CategoryBot> = {
  MIXED: new CategoryBot({ token: config.bots.mixed, category: 'MIXED', name: 'BuddyMixedBot' }),
  MOM_SON: new CategoryBot({ token: config.bots.momSon, category: 'MOM_SON', name: 'BuddyMomSonBot' }),
  SRI_LANKAN: new CategoryBot({ token: config.bots.sriLankan, category: 'SRI_LANKAN', name: 'BuddySriLankanBot' }),
  CCTV: new CategoryBot({ token: config.bots.cctv, category: 'CCTV', name: 'BuddyCCTVBot' }),
  PUBLIC: new CategoryBot({ token: config.bots.public, category: 'PUBLIC', name: 'BuddyPublicBot' }),
  RAPE: new CategoryBot({ token: config.bots.rape, category: 'RAPE', name: 'BuddyRapeBot' }),
};

export const startAllCategoryBots = () => {
  Object.values(categoryBots).forEach((bot) => {
    if (bot.hasToken) {
      bot.start();
    }
  });
};

export const stopAllCategoryBots = async () => {
  console.log('🛑 Stopping all category bots...');
  await Promise.all(
    Object.values(categoryBots)
      .filter((bot) => bot.hasToken)
      .map((bot) => bot.stop())
  );
};
