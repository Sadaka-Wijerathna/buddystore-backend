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
