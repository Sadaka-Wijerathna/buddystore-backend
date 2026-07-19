import { Response } from 'express';
import { Category, PaymentMethod, Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { uploadReceipt } from '../lib/cloudinary';
import { getIO } from '../lib/socket';
import { videoDeliveryQueue } from '../jobs/video.queue';
import { mainBot } from '../bots/main.bot';
import config from '../config';

/** Emit a real-time alert to all connected admin clients */
function notifyAdmins(event: string, payload: Record<string, unknown>) {
  try {
    getIO().to('admin').emit(event, payload);
  } catch {
    // Socket.io may not be initialised in tests — silently skip
  }
}

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
        pricePerVideo: bot.pricePerVideo,
      },
    });
  } catch (error) {
    console.error('[getCategoryLimits]', error);
    res.status(500).json({ success: false, message: 'Server error fetching category limits' });
  }
};

// ─── Initiate Order (Abandoned Cart Hook) ───────────────────────────────────
export const initiateOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { category, videoCount, priceAmount } = req.body;

    if (!category || !videoCount || !priceAmount) {
      res.status(400).json({ success: false, message: 'Missing fields' });
      return;
    }

    const count = parseInt(videoCount, 10);
    const price = parseFloat(priceAmount);

    const bot = await prisma.bot.findUnique({ where: { category: category as Category } });
    if (!bot) {
      res.status(404).json({ success: false, message: 'Bot not found' });
      return;
    }

    const order = await prisma.order.create({
      data: {
        userId,
        botId: bot.id,
        category: category as Category,
        videoCount: count,
        priceAmount: price,
        receiptUrl: 'PENDING_UPLOAD',
        status: 'INITIATED',
      },
    });

    res.json({ success: true, data: { orderId: order.id } });
  } catch (error) {
    console.error('[initiateOrder]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Create Single Order ──────────────────────────────────────────────────────
export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;



    const { orderId, category, videoCount, priceAmount } = req.body;

    // If orderId is provided, we just load it. Otherwise, validate fully.
    if (!orderId && (!category || !videoCount)) {
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

    const price = parseFloat(priceAmount);
    if (isNaN(price) || price <= 0) {
      res.status(400).json({ success: false, message: 'A valid positive price amount is required' });
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

    // ─── Wallet Logic ─────────────────────────────────────────
    const useWallet = req.body.useWallet === 'true';
    const userDb = await prisma.user.findUnique({ where: { id: userId } });
    const userWalletBalance = userDb?.walletBalance || 0;
    
    let walletUsed = 0;
    if (useWallet && userWalletBalance > 0) {
      walletUsed = Math.min(price, userWalletBalance);
    }

    const remainingToPay = price - walletUsed;

    if (remainingToPay > 0 && !req.file) {
      res.status(400).json({ 
        success: false, 
        message: walletUsed > 0 
          ? `Wallet applied, but payment receipt for remaining $${remainingToPay.toFixed(2)} is required` 
          : 'Payment receipt is required' 
      });
      return;
    }

    let receiptUrl: string | null = null;
    if (req.file) {
      receiptUrl = await uploadReceipt(
        req.file.buffer,
        `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
    } else {
      receiptUrl = 'PAID_VIA_WALLET';
    }

    const initialStatus = remainingToPay === 0 ? 'CONFIRMED' : 'PENDING';

    // Clean up any abandoned carts since they are placing a real order
    await prisma.order.deleteMany({ where: { userId, status: 'INITIATED' } });

    const transactionJobs = [];

    // Order creation or update promise
    if (orderId) {
      transactionJobs.push(prisma.order.update({
        where: { id: orderId },
        data: {
          receiptUrl,
          status: initialStatus,
          confirmedAt: initialStatus === 'CONFIRMED' ? new Date() : null,
          category: category as Category,
          videoCount: count,
          priceAmount: price,
        },
      }));
    } else {
      transactionJobs.push(prisma.order.create({
        data: {
          userId,
          botId: bot.id,
          category: category as Category,
          videoCount: count,
          priceAmount: price,
          receiptUrl,
          status: initialStatus,
          confirmedAt: initialStatus === 'CONFIRMED' ? new Date() : null,
        },
      }));
    }

    if (walletUsed > 0) {
      transactionJobs.push(prisma.user.update({
        where: { id: userId },
        data: { walletBalance: { decrement: walletUsed } }
      }));
      transactionJobs.push(prisma.walletTransaction.create({
        data: {
          userId,
          amount: walletUsed,
          type: 'SPENT',
          description: `Spent on ${category} order`
        }
      }));
    }

    const results = await prisma.$transaction(transactionJobs);
    const order = results[0] as any;

    // ─── Auto-Delivery Job ────────────────────────────────────
    if (initialStatus === 'CONFIRMED') {
      try {
        await videoDeliveryQueue.add(
          'deliver-videos',
          {
            orderId: order.id,
            userId: userId,
            userTelegramId: userDb!.telegramId.toString(),
            category: order.category,
            videoCount: order.videoCount,
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
        );
      } catch (queueErr) {
        console.error('[createOrder] Failed to queue delivery:', queueErr);
        // We don't fail the request here because the order IS created and confirmed. 
        // Admin can still manually retry or the worker might pick it up if partial.
      }
    }

    // Notify admins in real-time
    notifyAdmins('admin:new-order', {
      orderId: order.id,
      category: order.category,
      videoCount: order.videoCount,
      priceAmount: order.priceAmount,
      createdAt: order.createdAt,
    });

    res.status(201).json({
      success: true,
      message: remainingToPay === 0 ? 'Order placed and instantly confirmed via Wallet!' : 'Order placed successfully! Waiting for payment confirmation.',
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
//   useWallet — string 'true' or 'false'
export const createBatchOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const useWallet = req.body.useWallet === 'true';
    const paymentMethod = (req.body.paymentMethod as PaymentMethod) || 'BANK';
    const txHash = req.body.txHash as string | undefined;
    const cryptoCurrency = req.body.cryptoCurrency as string | undefined;
    const network = req.body.network as string | undefined;
    const cryptoAmount = req.body.cryptoAmount ? parseFloat(req.body.cryptoAmount) : undefined;

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

    let totalPriceRequired = 0;
    const errors: { category: string; message: string }[] = [];
    const validItems: { category: Category; count: number; price: number; botId: string }[] = [];

    for (const item of items) {
      const { category, videoCount, priceAmount } = item;

      if (!VALID_CATEGORIES.includes(category as Category)) {
        errors.push({ category, message: 'Invalid category' });
        continue;
      }

      const count = parseInt(String(videoCount), 10);
      if (isNaN(count) || count < 1 || count > 5000) {
        errors.push({ category, message: 'Video count must be between 1 and 5000' });
        continue;
      }

      const price = parseFloat(String(priceAmount));
      if (isNaN(price) || price <= 0) {
        errors.push({ category, message: 'A valid positive price amount is required' });
        continue;
      }

      const bot = await prisma.bot.findUnique({ where: { category: category as Category } });
      if (!bot) {
        errors.push({ category, message: 'No bot configured for this category' });
        continue;
      }

      const availableVideos = await prisma.videos.count({
        where: { category: category as Category, videoDeliveries: { none: { userId } } },
      });

      if (availableVideos < count) {
        errors.push({ category, message: `Only ${availableVideos} unique videos available for ${category}` });
        continue;
      }
      totalPriceRequired += price;
      validItems.push({ category: category as Category, count, price, botId: bot.id });
    }

    if (validItems.length === 0) {
      res.status(400).json({ success: false, message: 'No valid orders could be parsed', errors });
      return;
    }

    // ─── Wallet Logic ─────────────────────────────────────────
    const userDb = await prisma.user.findUnique({ where: { id: userId } });
    const userWalletBalance = userDb?.walletBalance || 0;
    
    let walletUsed = 0;
    if (useWallet && userWalletBalance > 0) {
      walletUsed = Math.min(totalPriceRequired, userWalletBalance);
    }

    const remainingToPay = totalPriceRequired - walletUsed;
    const fullyPaidByWallet = remainingToPay <= 0;

    // Receipt is required for Bank and Crypto (Manual) unless fully paid by wallet
    if (!fullyPaidByWallet && (paymentMethod === 'BANK' || paymentMethod === 'CRYPTO') && !req.file) {
      res.status(400).json({ success: false, message: 'Payment receipt is required' });
      return;
    }

    let starsToPay = 0;
    let starsInvoiceLink = '';

    if (!fullyPaidByWallet && paymentMethod === 'STARS') {
      // Calculate Stars based on LKR price and commission offset
      starsToPay = Math.ceil((remainingToPay / config.stars.rateLkr) * config.stars.commissionOffset);
    }

    let receiptUrl: string | null = null;
    if (!fullyPaidByWallet && (paymentMethod === 'BANK' || paymentMethod === 'CRYPTO') && req.file) {
      try {
        receiptUrl = await uploadReceipt(
          req.file.buffer,
          `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`
        );
      } catch (error) {
        console.error('Cloudinary upload error:', error);
        res.status(500).json({ success: false, message: 'Failed to upload receipt' });
        return;
      }
    } else if (paymentMethod === 'CRYPTO' && txHash) {
      receiptUrl = `CRYPTO_TXID:${txHash}`;
    } else if (paymentMethod === 'STARS') {
      receiptUrl = null;
    } else {
      receiptUrl = 'PAID_VIA_WALLET'; // dummy value when fully covered by wallet
    }

    // Clean up any abandoned carts since they are placing a real order
    await prisma.order.deleteMany({ where: { userId, status: 'INITIATED' } });

    const transactionJobs: any[] = [];
    let starsPaymentAttemptId: string | null = null;

    if (paymentMethod === 'STARS') {
      // Calculate Stars based on LKR price and commission offset
      starsToPay = Math.ceil((remainingToPay / config.stars.rateLkr) * config.stars.commissionOffset);
      
      // For Stars, we do NOT create Order records yet. 
      // We create a "Payment Attempt" that holds the item data.
      const attempt = await prisma.starsPaymentAttempt.create({
        data: {
          userId,
          items: validItems as any
        }
      });
      starsPaymentAttemptId = attempt.id;
    } else {
      // Logic for BANK, CRYPTO, WALLET (creates orders immediately)
      validItems.forEach(item => {
        const orderStatus = (remainingToPay === 0) ? 'CONFIRMED' : 'PENDING';
        transactionJobs.push(prisma.order.create({
          data: {
            userId,
            botId: item.botId,
            category: item.category,
            videoCount: item.count,
            priceAmount: item.price,
            receiptUrl,
            paymentMethod,
            txHash: paymentMethod === 'CRYPTO' ? txHash : null,
            cryptoAmount: paymentMethod === 'CRYPTO' ? cryptoAmount : null,
            cryptoCurrency: paymentMethod === 'CRYPTO' ? cryptoCurrency : null,
            network: paymentMethod === 'CRYPTO' ? network : null,
            status: orderStatus,
            confirmedAt: orderStatus === 'CONFIRMED' ? new Date() : null,
          },
        }));
      });
    }

    if (walletUsed > 0) {
      transactionJobs.push(prisma.user.update({
        where: { id: userId },
        data: { walletBalance: { decrement: walletUsed } }
      }));
      transactionJobs.push(prisma.walletTransaction.create({
        data: {
          userId,
          amount: walletUsed,
          type: 'SPENT',
          description: `Spent on ${validItems.length} categories (Stars Checkout)`
        }
      }));
    }

    const results = transactionJobs.length > 0 ? await prisma.$transaction(transactionJobs) : [];
    const createdOrders = results.filter(r => r && (r as any).userId) as any[]; // extract orders from results
    const createdOrderIds = createdOrders.map(o => o.id);

    // ─── If Stars Payment, create the invoice link now ────────────────────────
    if (paymentMethod === 'STARS' && starsToPay > 0 && starsPaymentAttemptId) {
      try {
        const title = `BuddyStore Order: ${validItems.length} categories`;
        const description = `Confirm your payment for ${validItems.length} video bundles.`;
        
        // Telegram payload is limited to 128 bytes. 
        const payload = `attempt:${starsPaymentAttemptId}`; 
        
        console.log(`[createBatchOrders] Generating invoice. Stars: ${starsToPay}, AttemptId: ${starsPaymentAttemptId}`);

        starsInvoiceLink = await mainBot.api.createInvoiceLink(
          title,
          description,
          payload,
          "", // Provider token (empty for Stars/XTR)
          "XTR", // Currency for Telegram Stars
          [{ label: "Digital Content", amount: starsToPay }]
        );

        console.log(`[createBatchOrders] Invoice Link SUCCESS: ${starsInvoiceLink}`);
      } catch (err) {
        console.error('[createBatchOrders] CRITICAL ERROR generating Stars invoice:', err);
      }
    }

    // ─── Auto-Delivery Jobs for Batch ──────────────────────────
    if (remainingToPay === 0) {
      for (const o of createdOrders) {
        try {
          await videoDeliveryQueue.add(
            'deliver-videos',
            {
              orderId: o.id,
              userId: userId,
              userTelegramId: userDb!.telegramId.toString(),
              category: o.category,
              videoCount: o.videoCount,
            },
            { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
          );
        } catch (queueErr) {
          console.error('[createBatchOrders] Failed to queue delivery:', queueErr);
        }
      }
    }

    // Notify admins in real-time
    const mappedCreatedOrders = createdOrders.map((o) => {
      notifyAdmins('admin:new-order', {
        orderId: o.id,
        category: o.category,
        status: o.status,
      });
      return { orderId: o.id, category: o.category, status: o.status };
    });

    res.status(201).json({
      success: true,
      message: remainingToPay === 0 
        ? `${mappedCreatedOrders.length} order(s) placed and instantly confirmed via Wallet!`
        : paymentMethod === 'STARS'
          ? "Please complete the payment using Telegram Stars to confirm your order."
          : `${mappedCreatedOrders.length} order(s) placed successfully! Waiting for payment confirmation.`,
      data: { 
        orders: mappedCreatedOrders, 
        errors,
        starsAmount: starsToPay,
        starsInvoiceLink,
        starsAttemptId: starsPaymentAttemptId
      },
    });
  } catch (error) {
    console.error('[createBatchOrders] CRITICAL ERROR:', error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
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
      priceAmount: order.priceAmount,
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

// ─── Get Smart Recommendations ────────────────────────────────────────────────
export const getRecommendations = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    
    // Get user's past purchased categories
    const pastOrders = await prisma.order.findMany({
      where: { userId, status: { in: ['CONFIRMED', 'DELIVERING', 'COMPLETED'] } },
      select: { category: true },
    });
    const purchasedCategories = new Set(pastOrders.map(o => o.category));
    
    // Get all active bots
    const bots = await prisma.bot.findMany({});
    
    interface Rec { category: string; botName: string; reason: string; priority: number }
    const recommendations: Rec[] = [];
    
    // Simple collaborative filtering rules
    bots.forEach(bot => {
      // Don't recommend what they already bought recently (unless we want to upsell repeats, but let's go for cross-sells)
      if (purchasedCategories.has(bot.category)) return;
      
      let priority = 0;
      let reason = 'Popular right now';
      
      // Rule 1: Cross-sell based on specific buys
      if (purchasedCategories.has('MOM_SON') && bot.category === 'MIXED') {
        priority += 10;
        reason = 'Because you bought Mom & Son';
      } else if (purchasedCategories.has('SRI_LANKAN') && bot.category === 'PUBLIC') {
        priority += 8;
        reason = 'Because you bought Sri Lankan';
      } else if (purchasedCategories.has('CCTV') && bot.category === 'RAPE') {
        priority += 8;
        reason = 'Because you bought CCTV';
      } else if (purchasedCategories.has('MIXED') && bot.category === 'MOM_SON') {
        priority += 7;
        reason = 'Because you bought Mixed packages';
      }
      
      // Rule 2: Boost by collection mode
      if (bot.collectionMode) {
        priority += 5;
        reason = reason === 'Popular right now' ? 'Currently in Collection Mode (Fresh!)' : reason;
      }
      
      // Base priority on total videos available mapped from 0 to 5 max
      priority += Math.min(5, bot.totalVideos / 1000);
      
      if (bot.totalVideos >= bot.minVideoCount) {
        recommendations.push({
          category: bot.category,
          botName: bot.name,
          reason,
          priority
        });
      }
    });
    
    // If they haven't bought anything, offer default best-sellers
    if (purchasedCategories.size === 0 && recommendations.length > 0) {
      recommendations.forEach(r => {
        if (r.category === 'MIXED') { r.priority = 100; r.reason = 'Top Seller for New Users'; }
        if (r.category === 'SRI_LANKAN') { r.priority = 90; r.reason = 'Trending Locally'; }
        if (r.category === 'MOM_SON') { r.priority = 80; r.reason = 'Highly Rated by Users'; }
      });
    }
    
    recommendations.sort((a, b) => b.priority - a.priority);
    
    res.json({ success: true, data: recommendations.slice(0, 4) });
  } catch (error) {
    console.error('[getRecommendations]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get Stars Payment Status ────────────────────────────────────────────────
// GET /orders/stars-status/:id
export const getStarsStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;

    const attempt = await prisma.starsPaymentAttempt.findUnique({
      where: { id },
    });

    if (!attempt || attempt.userId !== userId) {
      res.status(404).json({ success: false, message: 'Payment attempt not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        paid: attempt.paid,
        attemptId: attempt.id,
      },
    });
  } catch (error) {
    console.error('[getStarsStatus]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Fulfill Stars Order ─────────────────────────────────────────────────────
// POST /orders/stars-fulfill/:id
export const fulfillStarsOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;

    const attempt = await prisma.starsPaymentAttempt.findUnique({
      where: { id },
    });

    if (!attempt || attempt.userId !== userId) {
      res.status(404).json({ success: false, message: 'Payment attempt not found' });
      return;
    }

    if (!attempt.paid) {
      res.status(400).json({ success: false, message: 'Payment has not been verified yet' });
      return;
    }

    const items = attempt.items as any[];
    const userDb = await prisma.user.findUnique({ where: { id: userId } });

    // Create the real orders in a transaction
    const transactionJobs: any[] = items.map((item: any) => {
      return prisma.order.create({
        data: {
          userId,
          botId: item.botId,
          category: item.category,
          videoCount: item.count,
          priceAmount: item.price,
          paymentMethod: 'STARS',
          starsTransactionId: attempt.starsTransactionId,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          receiptUrl: null,
        },
      });
    });

    // Cleanup attempt record
    transactionJobs.push(prisma.starsPaymentAttempt.delete({ where: { id } }));

    const results = await prisma.$transaction(transactionJobs) as any[];
    const createdOrders = results.slice(0, items.length) as any[];

    // Queue delivery for each order
    for (const o of createdOrders) {
      try {
        await videoDeliveryQueue.add(
          'deliver-videos',
          {
            orderId: o.id,
            userId: userId,
            userTelegramId: userDb!.telegramId.toString(),
            category: o.category,
            videoCount: o.videoCount,
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
        );
      } catch (queueErr) {
        console.error('[fulfillStarsOrder] Failed to queue delivery:', queueErr);
      }
    }

    // Notify admins
    createdOrders.forEach(o => {
      notifyAdmins('admin:new-order', {
        orderId: o.id,
        category: o.category,
        status: o.status,
      });
    });

    res.status(201).json({
      success: true,
      message: 'Orders created and confirmed successfully!',
      data: { orders: createdOrders.map(o => ({ id: o.id, category: o.category })) },
    });
  } catch (error) {
    console.error('[fulfillStarsOrder]', error);
    res.status(500).json({ success: false, message: 'Server error fulfilling order' });
  }
};
