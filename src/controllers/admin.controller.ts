import { Response } from 'express';
import { OrderStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { videoDeliveryQueue } from '../jobs/video.queue';

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
      select: { id: true },
    });

    const videoIds = undeliveredVideos.map(v => v.id);

    if (videoIds.length > 0) {
      await prisma.videos.deleteMany({ where: { id: { in: videoIds } } });
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

// ─── Get all users ─────────────────────────────────────────────────────────
export const getUsers = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
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
    });

    res.json({ success: true, data: users });
  } catch (error) {
    console.error('[getUsers]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get all orders ────────────────────────────────────────────────────────
export const getAllOrders = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        user: {
          select: { telegramUsername: true, firstName: true, lastName: true },
        },
        _count: { select: { videoDeliveries: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

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
