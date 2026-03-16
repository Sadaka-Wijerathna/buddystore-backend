import { Response } from 'express';
import { Category } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { uploadReceipt } from '../lib/cloudinary';

const VALID_CATEGORIES: Category[] = ['MIXED', 'MOM_SON', 'SRI_LANKAN', 'CCTV', 'PUBLIC', 'RAPE'];

// ─── Get Category Limits ──────────────────────────────────────────────────────
export const getCategoryLimits = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { category } = req.query;

    if (!category || !VALID_CATEGORIES.includes(category as Category)) {
      res.status(400).json({ success: false, message: 'Valid category is required' });
      return;
    }

    const bot = await prisma.bot.findUnique({ where: { category: category as Category } });
    if (!bot) {
      res.status(404).json({ success: false, message: 'No bot configured for this category' });
      return;
    }

    const availableVideos = await prisma.videos.count({
      where: {
        category: category as Category,
        videoDeliveries: { none: { userId } },
      },
    });

    const alreadyReceived = await prisma.videoDelivery.count({
      where: {
        userId,
        video: { category: category as Category },
      },
    });

    res.json({
      success: true,
      data: {
        available: availableVideos,
        min: bot.minVideoCount,
        max: availableVideos,
        totalInBot: bot.totalVideos,
        alreadyReceived,
      },
    });
  } catch (error) {
    console.error('[getCategoryLimits]', error);
    res.status(500).json({ success: false, message: 'Server error fetching category limits' });
  }
};

// ─── Create Single Order ──────────────────────────────────────────────────────
export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    if (!req.file) {
      res.status(400).json({ success: false, message: 'Payment receipt is required' });
      return;
    }

    const { category, videoCount, priceAmount } = req.body;

    if (!category || !videoCount) {
      res.status(400).json({ success: false, message: 'Category and video count are required' });
      return;
    }

    if (!VALID_CATEGORIES.includes(category as Category)) {
      res.status(400).json({ success: false, message: 'Invalid category' });
      return;
    }

    const count = parseInt(videoCount, 10);
    if (isNaN(count) || count < 1 || count > 5000) {
      res.status(400).json({ success: false, message: 'Video count must be between 1 and 5000' });
      return;
    }

    const bot = await prisma.bot.findUnique({ where: { category: category as Category } });
    if (!bot) {
      res.status(404).json({ success: false, message: 'No bot configured for this category' });
      return;
    }

    const availableVideos = await prisma.videos.count({
      where: {
        category: category as Category,
        videoDeliveries: { none: { userId } },
      },
    });

    if (availableVideos < count) {
      res.status(400).json({
        success: false,
        message: `Only ${availableVideos} unique videos available for this category for you`,
      });
      return;
    }

    // Upload receipt to Cloudinary
    const receiptUrl = await uploadReceipt(
      req.file.buffer,
      `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const price = parseFloat(priceAmount) || 0;

    const order = await prisma.order.create({
      data: {
        userId,
        botId: bot.id,
        category: category as Category,
        videoCount: count,
        priceAmount: price,
        receiptUrl,
        status: 'PENDING',
      },
    });

    res.status(201).json({
      success: true,
      message: 'Order placed successfully! Waiting for payment confirmation.',
      data: { orderId: order.id, status: order.status },
    });
  } catch (error) {
    console.error('[createOrder]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Create one-time verify tokens for each cart category ─────────────────────
// POST /orders/bot-verify-tokens  body: { categories: string[] }
export const createBotVerifyTokens = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { categories } = req.body as { categories: string[] };

    if (!Array.isArray(categories) || categories.length === 0) {
      res.status(400).json({ success: false, message: 'categories array is required' });
      return;
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    // Only delete UNVERIFIED old tokens — keep verified ones so coming back to the page doesn't reset progress
    await prisma.botVerifyToken.deleteMany({
      where: { userId, verified: false },
    });

    const results = await Promise.all(
      categories.map(async (cat) => {
        // Reuse any already-verified token for this category
        const existing = await prisma.botVerifyToken.findFirst({
          where: { userId, category: cat as import('@prisma/client').Category, verified: true },
        });

        if (existing) {
          const bot = await prisma.bot.findUnique({
            where: { category: cat as import('@prisma/client').Category }, select: { name: true },
          });
          return {
            category: cat,
            token: existing.token,
            botName: bot?.name ?? cat,
            botUrl: `https://t.me/${bot?.name ?? cat}?start=${existing.token}`,
            verified: true,
          };
        }

        // Create a new token
        const [token, bot] = await Promise.all([
          prisma.botVerifyToken.create({
            data: { userId, category: cat as import('@prisma/client').Category, expiresAt },
          }),
          prisma.bot.findUnique({
            where: { category: cat as import('@prisma/client').Category }, select: { name: true },
          }),
        ]);
        return {
          category: cat,
          token: token.token,
          botName: bot?.name ?? cat,
          botUrl: `https://t.me/${bot?.name ?? cat}?start=${token.token}`,
          verified: false,
        };
      })
    );

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('[createBotVerifyTokens]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Poll verification status for a list of tokens ────────────────────────────
// GET /orders/bot-verify-tokens?tokens=tok1,tok2,...
export const pollBotVerifyTokens = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const raw = typeof req.query.tokens === 'string' ? req.query.tokens : '';
    const tokenIds = raw.split(',').map(t => t.trim()).filter(Boolean);

    const rows = await prisma.botVerifyToken.findMany({
      where: { token: { in: tokenIds } },
      select: { token: true, category: true, verified: true },
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[pollBotVerifyTokens]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── (Legacy) Check which category bots user has started ──────────────────────
export const checkUserBots = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ success: true, data: [] }); // deprecated — use bot-verify-tokens
};

// ─── Create Batch Orders (multiple categories, one receipt) ───────────────────
//   items    — JSON string: [{category, videoCount, priceAmount}, ...]
export const createBatchOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    if (!req.file) {
      res.status(400).json({ success: false, message: 'Payment receipt is required' });
      return;
    }

    // Parse items from JSON string in form-data
    let items: { category: string; videoCount: number; priceAmount: number }[];
    try {
      items = JSON.parse(req.body.items || '[]');
    } catch {
      res.status(400).json({ success: false, message: 'Invalid items format' });
      return;
    }

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, message: 'At least one order item is required' });
      return;
    }

    if (items.length > 10) {
      res.status(400).json({ success: false, message: 'Maximum 10 items per order' });
      return;
    }

    // Upload receipt to Cloudinary
    const receiptUrl = await uploadReceipt(
      req.file.buffer,
      `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const createdOrders: { orderId: string; category: string; status: string }[] = [];
    const errors: { category: string; message: string }[] = [];

    for (const item of items) {
      const { category, videoCount, priceAmount } = item;

      // Validate category
      if (!VALID_CATEGORIES.includes(category as Category)) {
        errors.push({ category, message: 'Invalid category' });
        continue;
      }

      const count = parseInt(String(videoCount), 10);
      if (isNaN(count) || count < 1 || count > 5000) {
        errors.push({ category, message: 'Video count must be between 1 and 5000' });
        continue;
      }

      // Find bot for this category
      const bot = await prisma.bot.findUnique({ where: { category: category as Category } });
      if (!bot) {
        errors.push({ category, message: 'No bot configured for this category' });
        continue;
      }

      // Check available videos
      const availableVideos = await prisma.videos.count({
        where: {
          category: category as Category,
          videoDeliveries: { none: { userId } },
        },
      });

      if (availableVideos < count) {
        errors.push({
          category,
          message: `Only ${availableVideos} unique videos available for ${category}`,
        });
        continue;
      }

      // Create the order
      const order = await prisma.order.create({
        data: {
          userId,
          botId: bot.id,
          category: category as Category,
          videoCount: count,
          priceAmount: parseFloat(String(priceAmount)) || 0,
          receiptUrl,
          status: 'PENDING',
        },
      });

      createdOrders.push({ orderId: order.id, category: order.category, status: order.status });
    }

    if (createdOrders.length === 0) {
      res.status(400).json({
        success: false,
        message: 'No orders could be created',
        errors,
      });
      return;
    }

    res.status(201).json({
      success: true,
      message: `${createdOrders.length} order(s) placed successfully! Waiting for payment confirmation.`,
      data: { orders: createdOrders, errors },
    });
  } catch (error) {
    console.error('[createBatchOrders]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get My Orders ────────────────────────────────────────────────────────────
export const getMyOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { videoDeliveries: true } },
      },
    });

    const ordersWithProgress = orders.map((order) => ({
      id: order.id,
      category: order.category,
      videoCount: order.videoCount,
      delivered: order._count.videoDeliveries,
      status: order.status,
      receiptUrl: order.receiptUrl,
      createdAt: order.createdAt,
      completedAt: order.completedAt,
    }));

    res.json({ success: true, data: ordersWithProgress });
  } catch (error) {
    console.error('[getMyOrders]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get Order By ID ──────────────────────────────────────────────────────────
export const getOrderById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const userId = req.user!.id;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        _count: { select: { videoDeliveries: true } },
      },
    });

    if (!order || order.userId !== userId) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    const deliveredCount = order._count.videoDeliveries;
    const percentComplete = Math.round((deliveredCount / order.videoCount) * 100);

    res.json({
      success: true,
      data: {
        id: order.id,
        category: order.category,
        videoCount: order.videoCount,
        delivered: deliveredCount,
        percentComplete,
        status: order.status,
        receiptUrl: order.receiptUrl,
        createdAt: order.createdAt,
        confirmedAt: order.confirmedAt,
        completedAt: order.completedAt,
      },
    });
  } catch (error) {
    console.error('[getOrderById]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
