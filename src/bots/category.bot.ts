import { Bot, Context } from 'grammy';
import { Category } from '@prisma/client';
import prisma from '../lib/prisma';

// ─── Category Bot Manager ──────────────────────────────────────────────────────
// Manages all 6 category bots. Each bot has collection mode that can be
// toggled by admin. When ON, any video sent to the bot is saved by its file_id.

interface CategoryBotConfig {
  token: string;
  category: Category;
  name: string;
}

export class CategoryBot {
  public bot: Bot | null = null;
  public category: Category;
  public name: string;
  public hasToken: boolean;
  private botDbId: string | null = null;

  constructor(cfg: CategoryBotConfig) {
    this.category = cfg.category;
    this.name = cfg.name;
    this.hasToken = !!cfg.token;

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
        await this.handleDocumentVideoMessage(ctx, doc.file_id);
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

    await this.saveVideo(video.file_id, botRecord.id);
    await ctx.react('👍');
  }

  private async handleVideoNoteMessage(ctx: Context) {
    const botRecord = await this.getBotRecord();
    if (!botRecord?.collectionMode) return;

    const videoNote = ctx.message?.video_note;
    if (!videoNote) return;

    await this.saveVideo(videoNote.file_id, botRecord.id);
    await ctx.react('👍');
  }

  private async handleDocumentVideoMessage(ctx: Context, fileId: string) {
    const botRecord = await this.getBotRecord();
    if (!botRecord?.collectionMode) return;

    await this.saveVideo(fileId, botRecord.id);
    await ctx.react('👍');
  }

  private async saveVideo(fileId: string, botDbId: string) {
    try {
      // Check if already saved (avoid duplicates)
      const existing = await prisma.videos.findUnique({ where: { fileId } });
      if (existing) return;

      await prisma.videos.create({
        data: { fileId, category: this.category, botId: botDbId },
      });

      // Update total count on bot record
      await prisma.bot.update({
        where: { id: botDbId },
        data: { totalVideos: { increment: 1 } },
      });

      console.log(`[${this.name}] Saved video: ${fileId}`);
    } catch (error) {
      console.error(`[${this.name}] Error saving video:`, error);
    }
  }

  private async getBotRecord() {
    if (this.botDbId) {
      return prisma.bot.findUnique({ where: { id: this.botDbId } });
    }
    const record = await prisma.bot.findUnique({ where: { category: this.category } });
    if (record) this.botDbId = record.id;
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
    });
  }
}

// ─── Bot Registry ──────────────────────────────────────────────────────────────
import config from '../config';

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
