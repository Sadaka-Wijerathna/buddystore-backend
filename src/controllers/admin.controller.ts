import { Response } from 'express';
import { OrderStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { videoDeliveryQueue } from '../jobs/video.queue';
import { uploadBanner, deleteCloudinaryImages } from '../lib/cloudinary';

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
        collectionMode: bot.collectionMode,
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

// ─── Update bot settings (min video count and price per video) ───────────────
// PATCH /admin/bots/:id/settings  { minVideoCount?, pricePerVideo? }
export const updateBotSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { minVideoCount, pricePerVideo } = req.body;

    const data: { minVideoCount?: number; pricePerVideo?: number } = {};

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

    if (Object.keys(data).length === 0) {
      res.status(400).json({ success: false, message: 'No valid fields to update' });
      return;
    }

    const bot = await prisma.bot.update({ where: { id }, data });

    res.json({
      success: true,
      message: `Settings updated for ${bot.name}`,
      data: { id: bot.id, minVideoCount: bot.minVideoCount, pricePerVideo: bot.pricePerVideo },
    });
  } catch (error) {
    console.error('[updateBotSettings]', error);
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

    // Only delete videos that have NOT been delivered to anyone.
    // Videos with delivery history are kept — we never lose delivery records.
    const undeliveredVideos = await prisma.videos.findMany({
      where: {
        botId: id,
        videoDeliveries: { none: {} }, // no delivery records = safe to delete
      },
      select: { id: true, thumbnailUrl: true },
    });

    const videoIds = undeliveredVideos.map(v => v.id);
    const thumbnailUrls = undeliveredVideos.map(v => v.thumbnailUrl).filter(Boolean) as string[];

    if (videoIds.length > 0) {
      await prisma.videos.deleteMany({ where: { id: { in: videoIds } } });

      // Fire and forget Cloudinary deletion
      if (thumbnailUrls.length > 0) {
        deleteCloudinaryImages(thumbnailUrls).catch(err => {
          console.error('[clearBotVideos] Cloudinary cleanup error:', err);
        });
      }
    }

    // Recalculate the real video count left in the library
    const remaining = await prisma.videos.count({ where: { botId: id } });
    await prisma.bot.update({ where: { id }, data: { totalVideos: remaining } });

    res.json({
      success: true,
      message: `Cleared ${videoIds.length} video(s) from ${bot.name}. ${remaining} delivered videos kept.`,
      data: { deleted: videoIds.length, remaining },
    });
  } catch (error) {
    console.error('[clearBotVideos]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get all users (paginated) ─────────────────────────────────────────────────
export const getUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const skip  = (page - 1) * limit;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          telegramUsername: true,
          firstName: true,
          lastName: true,
          languageCode: true,
          role: true,
          createdAt: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count(),
    ]);

    res.json({ success: true, data: users, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
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
            select: { telegramUsername: true, firstName: true, lastName: true },
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
    const { role } = req.body as { role: 'ADMIN' | 'USER' };

    if (!['ADMIN', 'USER'].includes(role)) {
      res.status(400).json({ success: false, message: 'Role must be ADMIN or USER' });
      return;
    }

    // Prevent self-demotion
    if (req.user?.id === targetId && role === 'USER') {
      res.status(400).json({ success: false, message: 'You cannot remove your own admin role' });
      return;
    }

    const user = await prisma.user.update({
      where: { id: targetId },
      data: { role },
      select: { id: true, telegramUsername: true, firstName: true, role: true },
    });

    res.json({
      success: true,
      message: `${user.firstName} is now ${role === 'ADMIN' ? 'an Admin' : 'a regular User'}`,
      data: user,
    });
  } catch (error) {
    console.error('[updateUserRole]', error);
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
        createdAt: true,
      },
    });

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
        orders: dayOrders.length,
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
    const completed     = orders.filter(o => o.status === 'COMPLETED').length;
    const weekAgo       = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weeklyOrders  = activeOrders.filter(o => new Date(o.createdAt) >= weekAgo).length;

    res.json({
      success: true,
      data: {
        dailyRevenue,
        statusBreakdown,
        categoryBreakdown,
        topStats: {
          totalRevenue,
          totalOrders: activeOrders.length,
          avgOrderValue: revenueOrders.length ? Math.round(totalRevenue / revenueOrders.length) : 0,
          completionRate: activeOrders.length ? Math.round((completed / activeOrders.length) * 100) : 0,
          weeklyOrders,
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

    res.json({
      success: true,
      data: collections.map((c: any) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        description: c.description,
        banner: c.banner,
        trendingTag: c.trendingTag,
        order: c.order,
        collectionMode: c.collectionMode,
        totalVideos: c._count.videos,
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
    const { slug, title, description, trendingTag, order } = req.body as { 
      slug: string; 
      title: string; 
      description?: string; 
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
        description,
        banner: bannerUrl,
        trendingTag: trendingTag || "Trending",
        order: order ? parseInt(String(order), 10) : 0,
      },
    });

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
    const { title, description, trendingTag, order } = req.body as { 
      title?: string; 
      description?: string; 
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
    if (description !== undefined) data.description = description;
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

