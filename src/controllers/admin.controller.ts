import { Response } from 'express';
import { OrderStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { videoDeliveryQueue } from '../jobs/video.queue';
import { uploadBanner, deleteCloudinaryImages, uploadMedia } from '../lib/cloudinary';
import { mainBot } from '../bots/main.bot';
import { specialBot } from '../bots/special.bot';
import { InputFile } from 'grammy';
import jwt from 'jsonwebtoken';
import config from '../config';
import { dispatchNotification } from './notification.controller';
import { syncTelegramProfile } from './auth.controller';

// ─── Get all bots with stats ───────────────────────────────────────────────
export const getBots = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const bots = await prisma.bot.findMany({
      include: { _count: { select: { videos: true } } },
      orderBy: { category: 'asc' },
    });

    res.json({
      success: true,
      data: bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        category: bot.category,
        label: bot.label || bot.category, // fall back to slug if label not set
        collectionMode: bot.collectionMode,
        collectVideos: bot.collectVideos,
        collectPhotos: bot.collectPhotos,
        totalVideos: bot._count.videos,
        minVideoCount: bot.minVideoCount,
        pricePerVideo: bot.pricePerVideo,
      })),
    });
  } catch (error) {
    console.error('[getBots]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Create a new bot for a category ──────────────────────────────────────
export const createBot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, token, category, label, minVideoCount, pricePerVideo, collectVideos, collectPhotos } = req.body;

    if (!name || !token || !category || typeof category !== 'string' || category.trim() === '') {
      res.status(400).json({ success: false, message: 'name, bot token, and a valid category slug are required' });
      return;
    }

    // Normalise: uppercase slug, trim whitespace
    const categorySlug = category.trim().toUpperCase().replace(/\s+/g, '_');
    const displayLabel = (label || '').trim() || categorySlug;

    // Check if bot already exists for this category
    const existing = await prisma.bot.findUnique({ where: { category: categorySlug } });
    if (existing) {
      res.status(409).json({ success: false, message: `A bot for category ${categorySlug} already exists` });
      return;
    }

    const bot = await prisma.bot.create({
      data: {
        name: name.trim(),
        token: token.trim(),
        category: categorySlug,
        label: displayLabel,
        minVideoCount: minVideoCount ? parseInt(minVideoCount, 10) : 10,
        pricePerVideo: pricePerVideo ? parseFloat(pricePerVideo) : 5,
        collectVideos: collectVideos !== undefined ? Boolean(collectVideos) : true,
        collectPhotos: collectPhotos !== undefined ? Boolean(collectPhotos) : false,
      },
    });

    // Register bot instance dynamically
    const { registerCategoryBot, categoryBots } = await import('../bots/category.bot');
    const newBotInstance = registerCategoryBot(bot.category, bot.token!, bot.name);

    // ── Also register webhook + Express route so the bot receives updates immediately ──
    // Without this, Telegram never knows where to POST updates for this newly-created bot.
    const { webhookCallback } = await import('grammy');
    const webhookBase   = config.webhookBaseUrl;
    const webhookSecret = config.webhookSecret || undefined;
    const slug = bot.name.replace(/^@/, '').toLowerCase();

    if (webhookBase && newBotInstance.bot) {
      // Tell Telegram where to deliver updates
      await newBotInstance.registerWebhook(webhookBase, slug, webhookSecret);

      // Mount the Express route so incoming webhook requests are handled
      const { default: expressApp } = await import('../app');
      expressApp.post(
        `/webhooks/${slug}`,
        webhookCallback(newBotInstance.bot, 'express', { secretToken: webhookSecret })
      );
      console.log(`[createBot] Mounted live webhook route: POST /webhooks/${slug}`);
    } else if (!webhookBase) {
      console.warn(`[createBot] WEBHOOK_BASE_URL not set — webhook for ${bot.name} not registered`);
    }

    res.status(201).json({
      success: true,
      message: `Bot for ${categorySlug} created successfully`,
      data: {
        id: bot.id,
        name: bot.name,
        category: bot.category,
        label: bot.label,
        minVideoCount: bot.minVideoCount,
        pricePerVideo: bot.pricePerVideo,
        collectionMode: bot.collectionMode,
        collectVideos: bot.collectVideos,
        collectPhotos: bot.collectPhotos,
        totalVideos: 0,
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ success: false, message: 'A bot with that name or category already exists' });
      return;
    }
    console.error('[createBot]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Delete a bot (and its videos) ──────────────────────────────────────────
export const deleteBot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);

    const bot = await prisma.bot.findUnique({ where: { id }, include: { _count: { select: { videos: true } } } });
    if (!bot) {
      res.status(404).json({ success: false, message: 'Bot not found' });
      return;
    }

    // Delete all videos for this bot first (to avoid FK constraint errors)
    await prisma.videos.deleteMany({ where: { botId: id } });
    await prisma.bot.delete({ where: { id } });

    res.json({
      success: true,
      message: `Bot for ${bot.category} deleted (${bot._count.videos} videos removed)`,
    });
  } catch (error) {
    console.error('[deleteBot]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Toggle collection mode ────────────────────────────────────────────────
export const toggleCollectionMode = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { enabled } = req.body;

    const bot = await prisma.bot.update({
      where: { id },
      data: { collectionMode: Boolean(enabled) },
    });

    res.json({
      success: true,
      message: `Collection mode ${bot.collectionMode ? 'enabled' : 'disabled'} for ${bot.name}`,
      data: { id: bot.id, collectionMode: bot.collectionMode },
    });
  } catch (error) {
    console.error('[toggleCollectionMode]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Update bot settings (display name, bot handle, min video count, price) ───
// PATCH /admin/bots/:id/settings  { label?, name?, minVideoCount?, pricePerVideo? }
export const updateBotSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { label, name, minVideoCount, pricePerVideo, collectVideos, collectPhotos } = req.body;

    const data: { label?: string; name?: string; minVideoCount?: number; pricePerVideo?: number; collectVideos?: boolean; collectPhotos?: boolean } = {};

    if (label !== undefined) {
      if (typeof label !== 'string' || !label.trim()) {
        res.status(400).json({ success: false, message: 'Display name cannot be empty' });
        return;
      }
      data.label = label.trim();
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ success: false, message: 'Bot handle cannot be empty' });
        return;
      }
      data.name = name.trim();
    }

    if (minVideoCount !== undefined) {
      const count = parseInt(minVideoCount, 10);
      if (isNaN(count) || count < 1) {
        res.status(400).json({ success: false, message: 'minVideoCount must be a positive integer' });
        return;
      }
      data.minVideoCount = count;
    }

    if (pricePerVideo !== undefined) {
      const price = parseFloat(pricePerVideo);
      if (isNaN(price) || price < 0) {
        res.status(400).json({ success: false, message: 'pricePerVideo must be a non-negative number' });
        return;
      }
      data.pricePerVideo = price;
    }

    if (collectVideos !== undefined) {
      data.collectVideos = Boolean(collectVideos);
    }

    if (collectPhotos !== undefined) {
      data.collectPhotos = Boolean(collectPhotos);
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ success: false, message: 'No valid fields to update' });
      return;
    }

    const bot = await prisma.bot.update({
      where: { id },
      data,
    });

    res.json({
      success: true,
      message: `Settings updated for ${bot.label || bot.name}`,
      data: bot,
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ success: false, message: 'A bot with that handle already exists' });
      return;
    }
    console.error('[updateBotSettings]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Update bot banner ───────────────────────────────────────────────────────
// PATCH /admin/bots/:id/banner
export const updateBotBanner = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);

    // 1. Check if bot exists
    const bot = await prisma.bot.findUnique({ where: { id } });
    if (!bot) {
      res.status(404).json({ success: false, message: 'Bot not found' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, message: 'No image file provided' });
      return;
    }

    // 2. Upload new banner to Cloudinary
    const filename = `bot_${bot.category}_${Date.now()}`;
    const secureUrl = await uploadBanner(req.file.buffer, filename);

    // 3. Delete old banner from Cloudinary if it exists
    if (bot.bannerUrl) {
      await deleteCloudinaryImages([bot.bannerUrl]).catch(e => {
        console.error('[updateBotBanner] Failed to delete old banner:', e);
      });
    }

    // 4. Save to database
    const updatedBot = await prisma.bot.update({
      where: { id },
      data: { bannerUrl: secureUrl },
    });

    res.json({
      success: true,
      message: 'Banner updated successfully',
      data: { id: updatedBot.id, bannerUrl: updatedBot.bannerUrl },
    });
  } catch (error) {
    console.error('[updateBotBanner]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Update bot min video count (kept for backwards-compat) ───────────────
export const updateBotMinVideoCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { minVideoCount } = req.body;

    const count = parseInt(minVideoCount, 10);
    if (isNaN(count) || count < 1) {
      res.status(400).json({ success: false, message: 'minVideoCount must be a positive integer' });
      return;
    }

    const bot = await prisma.bot.update({
      where: { id },
      data: { minVideoCount: count },
    });

    res.json({
      success: true,
      message: `Minimum video count updated to ${count} for ${bot.name}`,
      data: { id: bot.id, minVideoCount: bot.minVideoCount },
    });
  } catch (error) {
    console.error('[updateBotMinVideoCount]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Clear all videos for a bot ────────────────────────────────────────────
export const clearBotVideos = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);

    const bot = await prisma.bot.findUnique({ where: { id } });
    if (!bot) {
      res.status(404).json({ success: false, message: 'Bot not found' });
      return;
    }

    // Fetch all videos for this bot
    const videos = await prisma.videos.findMany({
      where: { botId: id },
      select: { id: true, thumbnailUrl: true },
    });

    const videoIds = videos.map(v => v.id);
    const thumbnailUrls = videos.map(v => v.thumbnailUrl).filter(Boolean) as string[];

    if (videoIds.length > 0) {
      // Delete delivery records referencing these videos first (FK constraint)
      await prisma.videoDelivery.deleteMany({ where: { videoId: { in: videoIds } } });

      // Now delete the videos themselves
      await prisma.videos.deleteMany({ where: { id: { in: videoIds } } });

      // Fire-and-forget Cloudinary thumbnail cleanup
      if (thumbnailUrls.length > 0) {
        deleteCloudinaryImages(thumbnailUrls).catch(err => {
          console.error('[clearBotVideos] Cloudinary cleanup error:', err);
        });
      }
    }

    // Reset the bot's video counter
    await prisma.bot.update({ where: { id }, data: { totalVideos: 0 } });

    res.json({
      success: true,
      message: `Cleared ${videoIds.length} video(s) from ${bot.name}.`,
      data: { deleted: videoIds.length, remaining: 0 },
    });
  } catch (error) {
    console.error('[clearBotVideos]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


// ─── Export Users to CSV ───────────────────────────────────────────────────────
export const exportUsersCSV = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        telegramId: true,
        telegramUsername: true,
        firstName: true,
        lastName: true,
        role: true,
        isBanned: true,
        lastIpAddress: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const header = ['ID', 'Telegram ID', 'Telegram Username', 'First Name', 'Last Name', 'Role', 'Status', 'Last IP', 'Joined Date'].join(',') + '\n';
    
    const rows = users.map(u => {
      // Escape fields properly: wrap in quotes and escape internal quotes
      const esc = (val: any) => {
        if (!val) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      };

      return [
        esc(u.id),
        esc(u.telegramId ? u.telegramId.toString() : ''),
        esc(u.telegramUsername),
        esc(u.firstName),
        esc(u.lastName),
        esc(u.role),
        esc(u.isBanned ? 'Banned' : 'Active'),
        esc(u.lastIpAddress),
        esc(new Date(u.createdAt).toISOString()),
      ].join(',');
    }).join('\n');

    const csvData = header + rows;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=buddystore_users.csv');
    res.status(200).send(csvData);
  } catch (error) {
    console.error('[exportUsersCSV]', error);
    res.status(500).json({ success: false, message: 'Server error during export' });
  }
};

// ─── Get all users (paginated) ─────────────────────────────────────────────────
export const getUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const skip  = (page - 1) * limit;

    const [users, total, bannedIps] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          telegramId: true,
          telegramUsername: true,
          firstName: true,
          lastName: true,
          languageCode: true,
          role: true,
          adminRole: true,
          isBanned: true,
          bannedAt: true,
          lastIpAddress: true,
          deviceType: true,
          lastLoginAt: true,
          photoUrl: true,
          createdAt: true,
          orders: { select: { receiptUrl: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count(),
      prisma.bannedIp.findMany({ select: { ip: true } }),
    ]);

    const bannedIpSet = new Set(bannedIps.map(b => b.ip));

    const mappedUsers = users.map(u => {
      const groups = new Set<string>();
      u.orders.forEach(o => {
        const timeKey = Math.floor(new Date(o.createdAt).getTime() / 5000);
        const key = `${o.receiptUrl || 'no-receipt'}_${timeKey}`;
        groups.add(key);
      });
      
      const { orders, ...rest } = u;
      return {
        ...rest,
        _count: { orders: groups.size },
        telegramId: rest.telegramId ? rest.telegramId.toString() : null,
        ipFlagged: !!(rest.lastIpAddress && bannedIpSet.has(rest.lastIpAddress)),
      };
    });

    res.json({ success: true, data: mappedUsers, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });

    // Background profile picture and details sync
    // Process sequentially to avoid Telegram rate-limiting
    (async () => {
      for (const u of users) {
        if (!u.telegramId) continue;
        try {
          const profile = await syncTelegramProfile(u.telegramId);
          if (profile) {
            const isUsernameChanged = profile.username && profile.username !== u.telegramUsername;
            await prisma.user.update({
              where: { id: u.id },
              data: { 
                photoUrl: profile.photoUrl,
                firstName: profile.firstName,
                lastName: profile.lastName,
                telegramUsername: profile.username || u.telegramUsername,
                ...(isUsernameChanged && {
                  oldTelegramUsername: u.telegramUsername,
                  usernameUpdatedAt: new Date(),
                })
              }
            });
          }
          // Small delay to respect Telegram's API limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
          // Ignore failures
        }
      }
    })();
  } catch (error) {
    console.error('[getUsers]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};



// ─── Get all orders (paginated + filterable) ──────────────────────────────────────
// Query params: ?page=1&limit=50&status=PENDING&category=MIXED
export const getAllOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const skip  = (page - 1) * limit;

    // Optional filters
    const where: Record<string, unknown> = {};
    if (req.query.status && typeof req.query.status === 'string') {
      where.status = req.query.status;
    }
    if (req.query.category && typeof req.query.category === 'string') {
      where.category = req.query.category;
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          user: {
            select: { telegramUsername: true, firstName: true, lastName: true, photoUrl: true },
          },
          _count: { select: { videoDeliveries: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    res.json({
      success: true,
      data: orders.map((order) => ({
        id: order.id,
        user: order.user,
        category: order.category,
        videoCount: order.videoCount,
        delivered: order._count.videoDeliveries,
        percentComplete: Math.round((order._count.videoDeliveries / order.videoCount) * 100),
        status: order.status,
        priceAmount: order.priceAmount,
        receiptUrl: order.receiptUrl,
        createdAt: order.createdAt,
        confirmedAt: order.confirmedAt,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[getAllOrders]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Update order status (Confirm / Reject) ───────────────────────────────
export const updateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { status } = req.body as { status: OrderStatus };

    if (!['CONFIRMED', 'REJECTED'].includes(status)) {
      res.status(400).json({ success: false, message: 'Status must be CONFIRMED or REJECTED' });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: { user: { select: { id: true, telegramId: true } } },
    });
    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    if (order.status !== 'PENDING') {
      res.status(400).json({ success: false, message: `Cannot change status of a ${order.status} order` });
      return;
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        status,
        confirmedAt: status === 'CONFIRMED' ? new Date() : undefined,
      },
    });

    // If confirmed, enqueue the video delivery job
    if (status === 'CONFIRMED') {
      await videoDeliveryQueue.add(
        'deliver-videos',
        {
          orderId: order.id,
          userId: order.user.id,
          userTelegramId: order.user.telegramId.toString(),
          category: order.category,
          videoCount: order.videoCount,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        }
      );
      console.log(`[Admin] Enqueued video delivery for order: ${order.id}`);
    }

    res.json({
      success: true,
      message: `Order ${status.toLowerCase()} successfully`,
      data: { id: updatedOrder.id, status: updatedOrder.status },
    });
  } catch (error) {
    console.error('[updateOrderStatus]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Confirm all PENDING orders sharing the same receipt URL ─────────────────
// PATCH /admin/orders/confirm-by-receipt   body: { receiptUrl: string }
export const confirmOrdersByReceipt = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { receiptUrl } = req.body as { receiptUrl: string };
    if (!receiptUrl) {
      res.status(400).json({ success: false, message: 'receiptUrl is required' });
      return;
    }

    const orders = await prisma.order.findMany({
      where: { receiptUrl, status: 'PENDING' },
      include: { user: { select: { id: true, telegramId: true } } },
    });

    if (orders.length === 0) {
      res.status(404).json({ success: false, message: 'No pending orders found for this receipt' });
      return;
    }

    const confirmed: string[] = [];
    for (const order of orders) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      await videoDeliveryQueue.add(
        'deliver-videos',
        {
          orderId: order.id,
          userId: order.user.id,
          userTelegramId: order.user.telegramId.toString(),
          category: order.category,
          videoCount: order.videoCount,
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
      );
      confirmed.push(order.id);
    }

    res.json({
      success: true,
      message: `${confirmed.length} order(s) confirmed and queued for delivery`,
      data: { confirmed },
    });
  } catch (error) {
    console.error('[confirmOrdersByReceipt]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get order delivery progress ──────────────────────────────────────────
export const getOrderProgress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);

    const order = await prisma.order.findUnique({
      where: { id },
      include: { _count: { select: { videoDeliveries: true } } },
    });

    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    const delivered = order._count.videoDeliveries;

    res.json({
      success: true,
      data: {
        orderId: order.id,
        status: order.status,
        total: order.videoCount,
        delivered,
        remaining: order.videoCount - delivered,
        percentComplete: Math.round((delivered / order.videoCount) * 100),
      },
    });
  } catch (error) {
    console.error('[getOrderProgress]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Update user role (promote / demote) ──────────────────────────────────
export const updateUserRole = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetId = String(req.params.id);
    const { role, adminRole } = req.body as { role: 'ADMIN' | 'USER', adminRole?: string | null };

    if (!['ADMIN', 'USER'].includes(role)) {
      res.status(400).json({ success: false, message: 'Role must be ADMIN or USER' });
      return;
    }

    // Prevent self-demotion
    if (req.user?.id === targetId && role === 'USER') {
      res.status(400).json({ success: false, message: 'You cannot remove your own admin role' });
      return;
    }

    // ── Protect SUPER_ADMIN — only @buddyseller keeps that role ──────────────
    // Nobody can be promoted to SUPER_ADMIN through this API endpoint.
    const VALID_ADMIN_ROLES = ['ORDER_MANAGER', 'UPLOADER', 'CONTENT_MANAGER'];
    if (adminRole === 'SUPER_ADMIN') {
      res.status(403).json({ success: false, message: 'SUPER_ADMIN cannot be assigned via the dashboard. Only @buddyseller holds that role.' });
      return;
    }
    if (role === 'ADMIN' && adminRole && !VALID_ADMIN_ROLES.includes(adminRole)) {
      res.status(400).json({ success: false, message: `Invalid adminRole. Must be one of: ${VALID_ADMIN_ROLES.join(', ')}` });
      return;
    }

    const dataToUpdate: any = { role, tokenVersion: { increment: 1 } };
    if (role === 'USER') {
      dataToUpdate.adminRole = null;
    } else if (adminRole !== undefined) {
      dataToUpdate.adminRole = adminRole;
    }

    const user = await prisma.user.update({
      where: { id: targetId },
      data: dataToUpdate,
      select: { id: true, telegramId: true, telegramUsername: true, firstName: true, role: true, adminRole: true, isBanned: true },
    });

    // Notify user via Telegram
    try {
      const msg = role === 'ADMIN' 
        ? "🚀 *Congratulations!* You have been promoted to an **Administrator** on [BuddyStore](https://buddystore.vercel.app)."
        : "ℹ️ Your administrative privileges have been removed. You are now a standard User.";
      await mainBot.api.sendMessage(user.telegramId.toString(), msg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.warn(`[updateUserRole Telegram Notify] Failed for user ${user.telegramId}:`, e);
    }

    res.json({
      success: true,
      message: `${user.firstName} is now ${role === 'ADMIN' ? 'an Admin' : 'a regular User'}`,
      data: {
        ...user,
        telegramId: user.telegramId.toString(),
      },
    });
  } catch (error) {
    console.error('[updateUserRole]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Ban / Unban user ──────────────────────────────────────────────────────
export const banUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetId = String(req.params.id);
    const { banned } = req.body as { banned: boolean };

    // Prevent self-ban
    if (req.user?.id === targetId) {
      res.status(400).json({ success: false, message: 'You cannot ban yourself' });
      return;
    }

    const user = await prisma.user.update({
      where: { id: targetId },
      data: {
        isBanned: banned,
        bannedAt: banned ? new Date() : null,
        // Increment tokenVersion when banning → instantly invalidates their active JWT
        ...(banned && { tokenVersion: { increment: 1 } }),
      },
      select: { id: true, telegramId: true, firstName: true, isBanned: true, bannedAt: true },
    });

    // Notify user via Telegram
    try {
      const msg = banned
        ? "🚫 *Account Restricted.* Your account has been suspended by an administrator. If you believe this is a mistake, please contact support."
        : "✅ *Account Restored.* Your account restrictions have been lifted. Welcome back!";
      await mainBot.api.sendMessage(user.telegramId.toString(), msg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.warn(`[banUser Telegram Notify] Failed for user ${user.telegramId}:`, e);
    }

    res.json({
      success: true,
      message: `${user.firstName} has been ${banned ? 'banned' : 'unbanned'}`,
      data: {
        ...user,
        telegramId: user.telegramId.toString(),
      },
    });
  } catch (error) {
    console.error('[banUser]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Delete user (cascade) ─────────────────────────────────────────────────
export const deleteUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetId = String(req.params.id);

    // Prevent self-deletion
    if (req.user?.id === targetId) {
      res.status(400).json({ success: false, message: 'You cannot delete your own account' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: targetId } });
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Delete cascade: videoDeliveries → videoDeliveryJobs → botVerifyTokens → orders → user
    await prisma.videoDelivery.deleteMany({ where: { userId: targetId } });
    await prisma.videoDeliveryJob.deleteMany({ where: { userId: targetId } });
    await prisma.botVerifyToken.deleteMany({ where: { userId: targetId } });
    // Orders reference videoDeliveries already deleted; delete orders next
    await prisma.order.deleteMany({ where: { userId: targetId } });
    await prisma.user.delete({ where: { id: targetId } });

    res.json({ success: true, message: `User "${user.firstName}" deleted successfully` });
  } catch (error) {
    console.error('[deleteUser]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get orders for a specific user ────────────────────────────────────────
export const getUserOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetId = String(req.params.id);

    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, firstName: true, lastName: true, telegramUsername: true },
    });
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const orders = await prisma.order.findMany({
      where: { userId: targetId },
      include: { _count: { select: { videoDeliveries: true } } },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: {
        user,
        orders: orders.map(o => ({
          id: o.id,
          category: o.category,
          videoCount: o.videoCount,
          delivered: o._count.videoDeliveries,
          status: o.status,
          priceAmount: o.priceAmount,
          paymentMethod: o.paymentMethod,
          receiptUrl: o.receiptUrl,
          createdAt: o.createdAt,
          confirmedAt: o.confirmedAt,
        })),
      },
    });
  } catch (error) {
    console.error('[getUserOrders]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Broadcast Message ──────────────────────────────────────────────────
export const broadcastMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { message, audience } = req.body as { message: string; audience?: string };
    const mediaFile = req.file;
    
    if (!message || message.trim() === '') {
      res.status(400).json({ success: false, message: 'Message is required' });
      return;
    }
    
    let mediaUrl: string | undefined;
    let mediaType: string | undefined;

    if (mediaFile) {
      const upload = await uploadMedia(mediaFile.buffer, mediaFile.originalname);
      mediaUrl = upload.url;
      mediaType = upload.type;
    }

    // Identify total audience count immediately for the record
    const whereClause: any = { isBanned: false };
    if (audience === 'ADMINS') whereClause.role = 'ADMIN';
    else if (audience === 'USERS') whereClause.role = 'USER';
    else if (audience === 'BANNED') whereClause.isBanned = true;
    else if (audience === 'ALL') { delete whereClause.isBanned; }

    const totalUsers = await prisma.user.count({ where: whereClause });

    const broadcast = await prisma.broadcast.create({
      data: {
        message,
        audience: audience || 'ALL',
        mediaUrl,
        mediaType,
        totalUsers,
        status: 'PENDING'
      }
    });
    
    res.json({ 
      success: true, 
      message: 'Broadcast initiated! Sending in background...',
      data: broadcast 
    });
  } catch (error) {
    console.error('[broadcastMessage]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Fetch history of all broadcasts
 */
export const getBroadcasts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const broadcasts = await prisma.broadcast.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    res.json({ success: true, data: broadcasts });
  } catch (err) {
    console.error('[getBroadcasts]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Fetch real-time progress for a specific broadcast
 */
export const getBroadcastStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const broadcast = await prisma.broadcast.findUnique({ 
      where: { id: String(id) } 
    });
    if (!broadcast) {
      res.status(404).json({ success: false, message: 'Broadcast not found' });
      return;
    }
    res.json({ success: true, data: broadcast });
  } catch (err) {
    console.error('[getBroadcastStatus]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Send Direct Message ────────────────────────────────────────────────
export const messageUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetId = String(req.params.id);
    const { message } = req.body as { message: string };
    const mediaFile = req.file;
    
    if (!message || message.trim() === '') {
      res.status(400).json({ success: false, message: 'Message is required' });
      return;
    }
    
    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: { telegramId: true, firstName: true }
    });
    
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    
    if (mediaFile) {
      const inputFile = new InputFile(mediaFile.buffer, mediaFile.originalname);
      if (mediaFile.mimetype.startsWith('image/')) {
        await mainBot.api.sendPhoto(user.telegramId.toString(), inputFile, { caption: message, parse_mode: 'HTML' });
      } else if (mediaFile.mimetype.startsWith('video/')) {
        await mainBot.api.sendVideo(user.telegramId.toString(), inputFile, { caption: message, parse_mode: 'HTML' });
      } else {
        await mainBot.api.sendDocument(user.telegramId.toString(), inputFile, { caption: message, parse_mode: 'HTML' });
      }
    } else {
      await mainBot.api.sendMessage(user.telegramId.toString(), message, { parse_mode: 'HTML' });
    }
    
    res.json({ success: true, message: `Message sent to ${user.firstName}` });
  } catch (error) {
    console.error('[messageUser]', error);
    if ((error as any).description?.includes('bot was blocked')) {
      res.status(400).json({ success: false, message: 'User blocked the bot. Cannot send message.' });
      return;
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Create Gift Order ──────────────────────────────────────────────────
export const createGiftOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetId = String(req.params.id);
    const { category, videoCount } = req.body as { category: string; videoCount: number };
    
    if (!category || !videoCount || videoCount <= 0) {
      res.status(400).json({ success: false, message: 'Invalid category or videoCount' });
      return;
    }
    
    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, telegramId: true, firstName: true }
    });
    
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    
    const bot = await prisma.bot.findUnique({ where: { category: category as any } });
    if (!bot) {
      res.status(404).json({ success: false, message: `Bot platform not found for category ${category}` });
      return;
    }
    
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        botId: bot.id,
        category: category as any,
        videoCount: videoCount,
        priceAmount: 0,
        receiptUrl: 'GIFT_PACKAGE',
        status: 'CONFIRMED',
        confirmedAt: new Date()
      }
    });
    
    await videoDeliveryQueue.add(
      'deliver-videos',
      {
        orderId: order.id,
        userId: user.id,
        userTelegramId: user.telegramId.toString(),
        category: order.category,
        videoCount: order.videoCount,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }
    );
    
    res.json({ success: true, message: `Gift package of ${videoCount} videos (${category}) sent to ${user.firstName}` });
  } catch (error) {
    console.error('[createGiftOrder]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


// ─── Analytics ────────────────────────────────────────────────────────────
export const getAnalytics = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orders = await prisma.order.findMany({
      where: { status: { not: 'REJECTED' } },
      select: {
        status: true,
        category: true,
        priceAmount: true,
        videoCount: true,
        receiptUrl: true,
        createdAt: true,
      },
    });

    const countBatches = (ordersList: typeof orders) => {
      const groups = new Set<string>();
      for (const o of ordersList) {
        const timeKey = Math.floor(new Date(o.createdAt).getTime() / 5000);
        const key = `${o.receiptUrl || 'no-receipt'}_${timeKey}`;
        groups.add(key);
      }
      return groups.size;
    };

    // Daily revenue — last 14 days
    const now = new Date();
    const dailyRevenue: { date: string; revenue: number; orders: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const dayOrders = orders.filter(o => {
        const created = new Date(o.createdAt).toISOString().slice(0, 10);
        return created === dateStr && o.status !== 'REJECTED';
      });
      dailyRevenue.push({
        date: dateStr,
        revenue: dayOrders.reduce((s, o) => s + Number(o.priceAmount), 0),
        orders: countBatches(dayOrders),
      });
    }

    // Status breakdown
    const statusBreakdown: Record<string, number> = {};
    for (const o of orders) {
      statusBreakdown[o.status] = (statusBreakdown[o.status] ?? 0) + 1;
    }

    // Category breakdown
    const catMap: Record<string, { orders: number; revenue: number; videos: number }> = {};
    for (const o of orders) {
      if (!catMap[o.category]) catMap[o.category] = { orders: 0, revenue: 0, videos: 0 };
      catMap[o.category].orders++;
      catMap[o.category].videos += o.videoCount;
      if (o.status !== 'REJECTED') catMap[o.category].revenue += Number(o.priceAmount);
    }
    const categoryBreakdown = Object.entries(catMap).map(([category, stats]) => ({
      category,
      ...stats,
    })).sort((a, b) => b.revenue - a.revenue);

    // Top stats
    const revenueOrders = orders.filter(o => ['CONFIRMED', 'DELIVERING', 'COMPLETED'].includes(o.status));
    const activeOrders  = orders.filter(o => o.status !== 'REJECTED');
    const totalRevenue  = revenueOrders.reduce((s, o) => s + Number(o.priceAmount), 0);
    
    const activeBatchesCount = countBatches(activeOrders);
    const completedBatchesCount = countBatches(orders.filter(o => o.status === 'COMPLETED'));
    const weekAgo       = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weeklyOrdersList = activeOrders.filter(o => new Date(o.createdAt) >= weekAgo);

    res.json({
      success: true,
      data: {
        dailyRevenue,
        statusBreakdown,
        categoryBreakdown,
        topStats: {
          totalRevenue,
          totalOrders: activeBatchesCount,
          avgOrderValue: countBatches(revenueOrders) ? Math.round(totalRevenue / countBatches(revenueOrders)) : 0,
          completionRate: activeBatchesCount ? Math.round((completedBatchesCount / activeBatchesCount) * 100) : 0,
          weeklyOrders: countBatches(weeklyOrdersList),
        },
      },
    });
  } catch (error) {
    console.error('[getAnalytics]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


// ─── Delete a single order ───────────────────────────────────────────────────
export const deleteOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    
    // The frontend passes either an order ID or a receiptUrl if it's a batch.
    // We want to delete all orders that match either the direct ID or the receiptUrl
    const ordersToDelete = await prisma.order.findMany({
      where: {
        OR: [{ id: id as string }, { receiptUrl: id as string }],
      },
      select: { id: true },
    });

    const orderIds = ordersToDelete.map(o => o.id);
    if (orderIds.length === 0) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    await prisma.videoDelivery.deleteMany({
      where: { orderId: { in: orderIds } },
    });

    await prisma.videoDeliveryJob.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    
    await prisma.order.deleteMany({
      where: { id: { in: orderIds } },
    });

    res.json({ success: true, message: 'Order(s) deleted successfully.' });
  } catch (error) {
    console.error('[deleteOrder]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Delete all orders (admin test cleanup) ────────────────────────────────
export const deleteAllOrders = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.videoDelivery.deleteMany({});
    await prisma.videoDeliveryJob.deleteMany({});
    const { count } = await prisma.order.deleteMany({});
    res.json({ success: true, message: `Deleted ${count} orders and all related deliveries.`, data: { count } });
  } catch (error) {
    console.error('[deleteAllOrders]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// ─── Special Bot Admin Endpoints ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// GET /admin/special-collections
export const getSpecialCollections = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const collections = await prisma.specialCollection.findMany({
      include: { _count: { select: { videos: true } } },
      orderBy: [
        { order: 'desc' },
        { createdAt: 'desc' }
      ],
    });

    // Count images per collection in a single query
    const imageCounts = await prisma.specialVideo.groupBy({
      by: ['collectionId'],
      where: { mediaType: 'image' },
      _count: { id: true },
    });
    const imageCountMap = new Map(imageCounts.map((r: any) => [r.collectionId, r._count.id]));

    res.json({
      success: true,
      data: collections.map((c: any) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        keywords: c.keywords,
        banner: c.banner,
        trendingTag: c.trendingTag,
        order: c.order,
        collectionMode: c.collectionMode,
        totalVideos: c._count.videos,
        totalImages: imageCountMap.get(c.id) ?? 0,
        createdAt: c.createdAt,
      })),
    });
  } catch (error) {
    console.error('[getSpecialCollections]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


// POST /admin/special-collections  { slug, title, description? }
export const createSpecialCollection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { slug, title, keywords, trendingTag, order } = req.body as { 
      slug: string; 
      title: string; 
      keywords?: string; 
      trendingTag?: string;
      order?: string | number;
    };

    if (!slug || !title) {
      res.status(400).json({ success: false, message: 'slug and title are required' });
      return;
    }

    // Validate slug format
    if (!/^[a-z0-9_]+$/.test(slug)) {
      res.status(400).json({ success: false, message: 'slug must be lowercase letters, numbers, and underscores only' });
      return;
    }

    let bannerUrl = null;
    if (req.file) {
      const ext = req.file.originalname.split('.').pop();
      const filename = `special-${slug}-${Date.now()}`;
      bannerUrl = await uploadBanner(req.file.buffer, filename);
    }

    const collection = await prisma.specialCollection.create({
      data: {
        slug,
        title,
        keywords,
        banner: bannerUrl,
        trendingTag: trendingTag || "Trending",
        order: order ? parseInt(String(order), 10) : 0,
      },
    });

    // Broadcast a new trending video notification
    await dispatchNotification(
      null,
      'new_trending',
      `Trending: ${title}`,
      `A new trending video collection has just been added. Check it out now!`
    );

    res.status(201).json({ success: true, data: collection });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ success: false, message: 'A collection with this slug already exists' });
      return;
    }
    console.error('[createSpecialCollection]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /admin/special-collections/:id  { title?, description?, trendingTag? }
export const updateSpecialCollection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { title, keywords, trendingTag, order } = req.body as { 
      title?: string; 
      keywords?: string; 
      trendingTag?: string; 
      order?: string | number;
    };
    
    const existing = await prisma.specialCollection.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Collection not found' });
      return;
    }

    const data: any = {};
    if (title) data.title = title;
    if (keywords !== undefined) data.keywords = keywords;
    if (trendingTag) data.trendingTag = trendingTag;
    if (order !== undefined) data.order = parseInt(String(order), 10);
    
    if (req.file) {
      const filename = `special-${existing.slug}-${Date.now()}`;
      data.banner = await uploadBanner(req.file.buffer, filename);
    }

    const collection = await prisma.specialCollection.update({
      where: { id },
      data,
    });

    res.json({ success: true, data: collection });
  } catch (error) {
    console.error('[updateSpecialCollection]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /admin/special-collections/reorder  { updates: { id, order }[] }
export const reorderSpecialCollections = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { updates } = req.body as { updates: { id: string; order: number }[] };

    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ success: false, message: 'Updates array is required' });
      return;
    }

    await prisma.$transaction(
      updates.map((u) =>
        prisma.specialCollection.update({
          where: { id: u.id },
          data: { order: u.order },
        })
      )
    );

    res.json({ success: true, message: 'Collections reordered successfully' });
  } catch (error) {
    console.error('[reorderSpecialCollections]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /admin/special-collections/:id/collection-mode  { enabled }
export const toggleSpecialCollectionMode = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { enabled } = req.body;

    const collection = await prisma.specialCollection.update({
      where: { id },
      data: { collectionMode: Boolean(enabled) },
    });

    res.json({
      success: true,
      message: `Collection mode ${collection.collectionMode ? 'enabled' : 'disabled'} for "${collection.title}"`,
      data: { id: collection.id, collectionMode: collection.collectionMode },
    });
  } catch (error) {
    console.error('[toggleSpecialCollectionMode]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /admin/special-collections/:id/videos — clear all videos from a collection
export const clearSpecialCollectionVideos = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);

    const collection = await prisma.specialCollection.findUnique({ where: { id } });
    if (!collection) {
      res.status(404).json({ success: false, message: 'Collection not found' });
      return;
    }

    // Collect thumbnail URLs before deleting so we can clean up Cloudinary
    const videos = await prisma.specialVideo.findMany({
      where: { collectionId: id },
      select: { thumbnailUrl: true },
    });
    const thumbnailUrls = videos.map((v) => v.thumbnailUrl);

    const { count } = await prisma.specialVideo.deleteMany({ where: { collectionId: id } });

    await prisma.specialCollection.update({
      where: { id },
      data: { totalVideos: 0 },
    });

    // Fire-and-forget Cloudinary cleanup (non-blocking, non-fatal)
    deleteCloudinaryImages(thumbnailUrls).catch((err) =>
      console.error('[clearSpecialCollectionVideos] Cloudinary cleanup error:', err)
    );

    res.json({
      success: true,
      message: `Cleared ${count} video(s) from "${collection.title}"`,
      data: { deleted: count },
    });
  } catch (error) {
    console.error('[clearSpecialCollectionVideos]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /admin/special-collections/:id — delete a whole collection
export const deleteSpecialCollection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);

    // Collect thumbnail URLs + banner before deleting DB records
    const [videos, collection] = await Promise.all([
      prisma.specialVideo.findMany({
        where: { collectionId: id },
        select: { thumbnailUrl: true },
      }),
      prisma.specialCollection.findUnique({ where: { id }, select: { banner: true } }),
    ]);

    const cloudinaryUrls = [
      ...videos.map((v) => v.thumbnailUrl),
      collection?.banner,
    ];

    await prisma.specialVideo.deleteMany({ where: { collectionId: id } });
    await prisma.specialCollection.delete({ where: { id } });

    // Fire-and-forget Cloudinary cleanup (non-blocking, non-fatal)
    deleteCloudinaryImages(cloudinaryUrls).catch((err) =>
      console.error('[deleteSpecialCollection] Cloudinary cleanup error:', err)
    );

    res.json({ success: true, message: 'Collection deleted' });
  } catch (error) {
    console.error('[deleteSpecialCollection]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Send Advanced Gift ──────────────────────────────────────────────────
export const sendAdvancedGift = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { userIds, giftType, itemId, count } = req.body as {
      userIds: string[];
      giftType: 'CATEGORY' | 'SPECIAL' | 'PDF';
      itemId: string;
      count?: number;
    };

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({ success: false, message: 'At least one user must be selected' });
      return;
    }

    if (!giftType || !itemId) {
      res.status(400).json({ success: false, message: 'giftType and itemId are required' });
      return;
    }

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, telegramId: true, firstName: true }
    });

    if (users.length === 0) {
      res.status(404).json({ success: false, message: 'No valid users found' });
      return;
    }

    if (giftType === 'CATEGORY') {
      const videoCount = count && count > 0 ? count : 20;
      const bot = await prisma.bot.findUnique({ where: { category: itemId as any } });
      if (!bot) {
        res.status(404).json({ success: false, message: `Bot platform not found for category ${itemId}` });
        return;
      }

      for (const u of users) {
        const order = await prisma.order.create({
          data: {
            userId: u.id,
            botId: bot.id,
            category: itemId as any,
            videoCount,
            priceAmount: 0,
            receiptUrl: 'GIFT_PACKAGE',
            status: 'CONFIRMED',
            confirmedAt: new Date()
          }
        });
        
        await videoDeliveryQueue.add(
          'deliver-videos',
          {
            orderId: order.id,
            userId: u.id,
            userTelegramId: u.telegramId.toString(),
            category: order.category,
            videoCount: order.videoCount,
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
        );
      }
    } else if (giftType === 'SPECIAL') {
      const collection = await prisma.specialCollection.findUnique({ where: { id: itemId } });
      if (!collection) {
        res.status(404).json({ success: false, message: 'Special Collection not found' });
        return;
      }

      const specialVideos = await prisma.specialVideo.findMany({
        where: { collectionId: itemId },
        select: { fileId: true, mediaType: true },
      });

      if (specialVideos.length === 0) {
        res.status(400).json({ success: false, message: 'No videos currently available in this special collection.' });
        return;
      }

      // Send asynchronously without tracking in DB via traditional orders 
      // Iterate synchronously over users to avoid spamming the bot API
      (async () => {
        const botToUse = specialBot || mainBot;
        if (!specialBot) {
          console.warn('[Admin Gift] specialBot not initialized, falling back to mainBot');
        }
        
        for (const u of users) {
          try {
            await botToUse.api.sendMessage(u.telegramId.toString(), `🎁 *Gift from Admin!*\nEnjoy these videos from ${collection.title}!`, { parse_mode: 'Markdown' });
            for (let i = 0; i < specialVideos.length; i++) {
              try {
                const media = specialVideos[i];
                if ((media as any).mediaType === 'image') {
                  await botToUse.api.sendPhoto(u.telegramId.toString(), media.fileId);
                } else {
                  await botToUse.api.sendVideo(u.telegramId.toString(), media.fileId);
                }
                await new Promise(r => setTimeout(r, 100)); // Rate limit 10/sec safety
              } catch (videoErr: any) {
                const code = videoErr?.error_code;
                const desc = videoErr?.description || '';
                if (code === 403 || code === 400 || desc.includes('blocked') || desc.includes('deactivated')) {
                  console.warn(`[Admin Gift] User ${u.telegramId} blocked bot. Aborting special delivery.`);
                  break;
                }
                if (code === 429) {
                  const retry = videoErr?.parameters?.retry_after || 5;
                  console.warn(`[Admin Gift] Rate limited (429). Pausing ${retry}s.`);
                  await new Promise(r => setTimeout(r, retry * 1000));
                }
              }
            }
          } catch (e: any) {
            console.error(`[Admin Gift] Failed to send Special Collection to ${u.telegramId.toString()}:`, e?.message);
            if (e?.error_code === 429) {
              const retry = e?.parameters?.retry_after || 5;
              await new Promise(r => setTimeout(r, retry * 1000));
            }
          }
        }
      })();
    } else if (giftType === 'PDF') {
      const pdf = await prisma.freePdf.findUnique({ where: { id: itemId } });
      if (!pdf) {
        res.status(404).json({ success: false, message: 'Free PDF not found' });
        return;
      }

      (async () => {
        for (const u of users) {
          try {
            await mainBot.api.sendMessage(u.telegramId.toString(), `🎁 *Gift from Admin!*\nEnjoy this free PDF: ${pdf.title}`, { parse_mode: 'Markdown' });
            await mainBot.api.sendDocument(u.telegramId.toString(), pdf.fileUrl);
          } catch (e) {
            console.error(`[Admin Gift] Failed to send PDF to ${u.telegramId.toString()}:`, e);
          }
        }
      })();
    } else {
      res.status(400).json({ success: false, message: 'Invalid giftType' });
      return;
    }

    res.json({ success: true, message: `Gift successfully initiated for ${users.length} user(s)` });
  } catch (error) {
    console.error('[sendAdvancedGift]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
// ─── Get Banned IPs ─────────────────────────────────────────────────────────────────
export const getBannedIps = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const bannedIps = await prisma.bannedIp.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: bannedIps });
  } catch (error) {
    console.error('[getBannedIps]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Add Banned IP ─────────────────────────────────────────────────────────────────
export const addBannedIp = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { ip, reason } = req.body as { ip: string; reason?: string };
    if (!ip || !ip.trim()) {
      res.status(400).json({ success: false, message: 'IP address is required' });
      return;
    }

    const banned = await prisma.bannedIp.upsert({
      where: { ip: ip.trim() },
      create: { ip: ip.trim(), reason: reason?.trim() ?? null, bannedBy: req.user?.id },
      update: { reason: reason?.trim() ?? null, bannedBy: req.user?.id },
    });

    res.json({ success: true, message: `IP ${banned.ip} has been banned`, data: banned });
  } catch (error) {
    console.error('[addBannedIp]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Remove Banned IP ────────────────────────────────────────────────────────────────
export const removeBannedIp = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ip = decodeURIComponent(String(req.params.ip));

    // Find users associated with this IP to notify them before deletion
    const users = await prisma.user.findMany({
      where: { lastIpAddress: ip },
      select: { telegramId: true }
    });

    await prisma.bannedIp.delete({ where: { ip } });

    // Notify users via Telegram
    for (const u of users) {
      try {
        await mainBot.api.sendMessage(u.telegramId.toString(), `✅ *Security Update:* Your IP address restriction (\`${ip}\`) has been lifted. You can now use all services normally.`, { parse_mode: 'Markdown' });
      } catch (e) {
        console.warn(`[removeBannedIp Telegram Notify] Failed for user ${u.telegramId}:`, e);
      }
    }

    res.json({ success: true, message: `IP ${ip} has been unbanned` });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ success: false, message: 'IP not found in ban list' });
      return;
    }
    console.error('[removeBannedIp]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Ban user's IP (quick action from user row) ────────────────────────────────
export const banUserIp = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetId = String(req.params.id);
    const { reason } = req.body as { reason?: string };

    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, telegramId: true, firstName: true, lastIpAddress: true },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (!user.lastIpAddress) {
      res.status(400).json({ success: false, message: 'No IP recorded for this user yet' });
      return;
    }

    const banned = await prisma.bannedIp.upsert({
      where: { ip: user.lastIpAddress },
      create: { ip: user.lastIpAddress, reason: reason ?? `Banned via user: ${user.firstName}`, bannedBy: req.user?.id },
      update: { reason: reason ?? `Banned via user: ${user.firstName}`, bannedBy: req.user?.id },
    });

    // Notify user via Telegram
    try {
      await mainBot.api.sendMessage(user.telegramId.toString(), "⚠️ *Security Alert:* Your current IP address has been flagged and restricted for security reasons. Please contact support.", { parse_mode: 'Markdown' });
    } catch (e) {
      console.warn(`[banUserIp Telegram Notify] Failed for user ${user.telegramId}:`, e);
    }

    res.json({ success: true, message: `IP ${banned.ip} (from ${user.firstName}) has been banned`, data: banned });
  } catch (error) {
    console.error('[banUserIp]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── God Mode: Generate impersonation token for a target user ────────────────
// POST /admin/users/:id/impersonate
// The admin's own token is never invalidated — the frontend saves it separately
// and restores it when "Exit God Mode" is clicked.
export const impersonateUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetId = String(req.params.id);
    const adminId  = req.user!.id;

    // Prevent self-impersonation (pointless but guard anyway)
    if (adminId === targetId) {
      res.status(400).json({ success: false, message: 'You cannot impersonate yourself' });
      return;
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, telegramId: true, telegramUsername: true, firstName: true, lastName: true, role: true, isBanned: true, tokenVersion: true },
    });

    if (!target) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Safety: don't allow impersonating another admin (could be exploited)
    if (target.role === 'ADMIN') {
      res.status(403).json({ success: false, message: 'Cannot impersonate another admin account' });
      return;
    }

    if (target.isBanned) {
      res.status(400).json({ success: false, message: 'Cannot impersonate a banned user' });
      return;
    }

    // Issue a short-lived (2 h) impersonation token
    const impersonationToken = jwt.sign(
      { id: target.id, role: target.role, telegramUsername: target.telegramUsername, tokenVersion: target.tokenVersion },
      config.jwt.secret,
      { expiresIn: '2h' } as jwt.SignOptions
    );

    console.log(`[GodMode] Admin ${adminId} is impersonating user ${target.id} (@${target.telegramUsername})`);

    res.json({
      success: true,
      message: `God Mode activated — you are now logged in as ${target.firstName}`,
      data: {
        token: impersonationToken,
        user: {
          id: target.id,
          telegramId: target.telegramId?.toString() ?? null,
          telegramUsername: target.telegramUsername,
          firstName: target.firstName,
          lastName: target.lastName,
          role: target.role,
        },
      },
    });
  } catch (error) {
    console.error('[impersonateUser]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Settings Controller ──────────────────────────────────────────────────
export const adminGetSettings = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await prisma.setting.findMany();
    // Convert array of {key, value} to an object map
    const map: Record<string, string> = settings.reduce((acc: Record<string, string>, s: any) => ({ ...acc, [s.key]: s.value }), {});
    
    // Add defaults if they don't exist in DB yet
    if (!map['REFERRAL_REWARD_AMOUNT']) {
      map['REFERRAL_REWARD_AMOUNT'] = '300';
    }

    res.json({ success: true, data: map });
  } catch (error) {
    console.error('[adminGetSettings]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adminUpdateSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const updates = req.body as Record<string, string>;
    
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value === 'string') {
        await prisma.setting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        });
      }
    }

    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (error) {
    console.error('[adminUpdateSettings]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Affiliates Controller ───────────────────────────────────────────────
export const adminGetAffiliates = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const skip  = (page - 1) * limit;

    // We only care about users who HAVE referred others or have a referral code
    const baseQuery = {
      where: {
        OR: [
          { referredUsers: { some: {} } },
          { referralCode: { not: null } }
        ]
      }
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        ...baseQuery,
        select: {
          id: true,
          telegramUsername: true,
          firstName: true,
          walletBalance: true,
          _count: { select: { referredUsers: true } },
          walletTransactions: {
            select: { amount: true, type: true }
          }
        },
        orderBy: {
          referredUsers: { _count: 'desc' }
        },
        skip,
        take: limit,
      }),
      prisma.user.count(baseQuery)
    ]);

    const mappedData = users.map(u => {
      const totalEarned = u.walletTransactions
        .filter(t => t.type === 'EARNED')
        .reduce((acc, tx) => acc + tx.amount, 0);
      const totalSpent = u.walletTransactions
        .filter(t => t.type === 'SPENT')
        .reduce((acc, tx) => acc + tx.amount, 0);
      
      // Calculate true balance in case DB column is out of sync
      const derivedBalance = totalEarned - totalSpent;

      return {
        id: u.id,
        telegramUsername: u.telegramUsername,
        firstName: u.firstName,
        totalInvites: u._count.referredUsers,
        walletBalance: derivedBalance > u.walletBalance ? derivedBalance : u.walletBalance,
        totalEarned
      };
    });

    res.json({
      success: true,
      data: mappedData,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('[adminGetAffiliates]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Wallet & Affiliate destructive actions ──────────────────────────────────
export const adminAdjustWallet = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.params.id as string;
    const { amount, description } = req.body;

    if (amount === undefined) {
      res.status(400).json({ success: false, message: 'Amount is required' });
      return;
    }

    const numAmount = Number(amount);
    const absAmount = Math.abs(numAmount);
    const txType = numAmount >= 0 ? 'EARNED' : 'SPENT';

    // Update balance and create transaction in a single database transaction
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { walletBalance: { increment: numAmount } }
      }),
      prisma.walletTransaction.create({
        data: {
          userId,
          amount: absAmount,         // always positive; type conveys direction
          type: txType,
          description: description || 'Admin manual adjustment'
        }
      })
    ]);

    dispatchNotification(
      userId,
      'wallet_bonus',
      `Wallet Adjusted (${numAmount >= 0 ? '+' : ''}${numAmount})`,
      description || 'Admin performed a manual adjustment to your wallet.'
    ).catch(e => console.error(e));

    res.json({ success: true, message: 'Wallet adjusted successfully' });
  } catch (error) {
    console.error('[adminAdjustWallet]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adminClearAffiliateData = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    // 1. Delete all wallet transactions
    // 2. Reset all user wallet balances, referredById, and referralCodes
    await prisma.$transaction([
      prisma.walletTransaction.deleteMany({}),
      prisma.user.updateMany({
        data: {
          walletBalance: 0,
          referredById: null,
          referralCode: null
        }
      })
    ]);

    res.json({ success: true, message: 'Affiliate database cleared successfully. Fresh start!' });
  } catch (error) {
    console.error('[adminClearAffiliateData]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
// ─── Bank Accounts Management (Admin) ───────────────────────────────────────

export const adminGetBankAccounts = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const accounts = await prisma.bankAccount.findMany({
      orderBy: { order: 'asc' },
    });
    res.json({ success: true, data: accounts });
  } catch (error) {
    console.error('[adminGetBankAccounts]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adminCreateBankAccount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { bankName, accountName, accountNumber, branch, isActive, order } = req.body;
    if (!bankName || !accountName || !accountNumber) {
      res.status(400).json({ success: false, message: 'Missing required fields' });
      return;
    }

    const account = await prisma.bankAccount.create({
      data: {
        bankName,
        accountName,
        accountNumber,
        branch,
        isActive: isActive !== undefined ? isActive : true,
        order: order !== undefined ? parseInt(String(order)) : 0,
      },
    });

    res.json({ success: true, data: account });
  } catch (error) {
    console.error('[adminCreateBankAccount]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adminUpdateBankAccount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { bankName, accountName, accountNumber, branch, isActive, order } = req.body;

    const account = await prisma.bankAccount.update({
      where: { id: id as string },
      data: {
        bankName,
        accountName,
        accountNumber,
        branch,
        isActive,
        order: order !== undefined ? parseInt(String(order)) : undefined,
      },
    });

    res.json({ success: true, data: account });
  } catch (error) {
    console.error('[adminUpdateBankAccount]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adminDeleteBankAccount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await prisma.bankAccount.delete({ where: { id: id as string } });
    res.json({ success: true, message: 'Bank account deleted' });
  } catch (error) {
    console.error('[adminDeleteBankAccount]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
