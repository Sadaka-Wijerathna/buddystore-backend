import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { uploadReceipt } from '../lib/cloudinary';
import { dispatchNotification } from './notification.controller';
import { resolveTgFileUrl } from './auth.controller';

interface AuthRequest extends Request {
  user?: { id: string; role: string; adminRole?: string };
}

// ─── Helper: check if a user has an active badge ─────────────────────────────
export async function hasActiveBadge(userId: string): Promise<boolean> {
  const badge = await prisma.superBadge.findUnique({
    where: { userId },
    select: { status: true, expiresAt: true },
  });
  return badge?.status === 'ACTIVE' && badge.expiresAt > new Date();
}

// ─── Activate a badge (status only — wallet is NOT modified) ─────────────────
async function activateBadge(badgeId: string, _userId: string): Promise<void> {
  await prisma.superBadge.update({
    where: { id: badgeId },
    data: { status: 'ACTIVE' },
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/badge/plans
// List all active badge plans (sorted by display order)
// ─────────────────────────────────────────────────────────────────────────────
export const getBadgePlans = async (_req: Request, res: Response): Promise<void> => {
  try {
    const plans = await prisma.superBadgePlan.findMany({
      where: { isActive: true },
      orderBy: { order: 'asc' },
      select: {
        id: true,
        name: true,
        durationDays: true,
        price: true,
        order: true,
      },
    });
    // Plans change only when admin adds/edits one — safe to cache for 5 minutes.
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json({ success: true, data: plans });
  } catch (error) {
    console.error('[getBadgePlans]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/badge/status
// Get the current user's badge status
// ─────────────────────────────────────────────────────────────────────────────
export const getBadgeStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const badge = await prisma.superBadge.findUnique({
      where: { userId },
      include: { plan: { select: { name: true, durationDays: true } } },
    });

    if (!badge) {
      res.json({ success: true, data: null });
      return;
    }

    const isActive = badge.status === 'ACTIVE' && badge.expiresAt > new Date();

    res.json({
      success: true,
      data: {
        id: badge.id,
        status: badge.status,
        isActive,
        expiresAt: badge.expiresAt,
        planName: badge.plan.name,
        durationDays: badge.plan.durationDays,
        createdAt: badge.createdAt,
      },
    });
  } catch (error) {
    console.error('[getBadgeStatus]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/badge/purchase
// Purchase or extend a badge.
// Body: { planId, paymentMethod: 'WALLET' | 'BANK' }
// File (optional): receipt image (required for BANK)
// ─────────────────────────────────────────────────────────────────────────────
export const purchaseBadge = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const { planId, paymentMethod } = req.body;

    if (!planId || !paymentMethod) {
      res.status(400).json({ success: false, message: 'planId and paymentMethod are required' });
      return;
    }

    if (!['WALLET', 'BANK', 'CRYPTO', 'BINANCE'].includes(paymentMethod)) {
      res.status(400).json({ success: false, message: 'Invalid payment method' });
      return;
    }

    // Fetch plan
    const plan = await prisma.superBadgePlan.findUnique({
      where: { id: planId },
      select: { id: true, name: true, durationDays: true, price: true, isActive: true },
    });

    if (!plan || !plan.isActive) {
      res.status(404).json({ success: false, message: 'Badge plan not found or inactive' });
      return;
    }

    // ── Wallet payment: deduct price then activate immediately ────────────────
    if (paymentMethod === 'WALLET') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { walletBalance: true },
      });

      const currentBalance = user?.walletBalance ?? 0;
      if (currentBalance < plan.price) {
        res.status(400).json({
          success: false,
          message: `Insufficient wallet balance. Need $${plan.price.toFixed(2)}, have $${currentBalance.toFixed(2)}`,
        });
        return;
      }

      // Compute expiry — extend if already has a badge
      const existingBadge = await prisma.superBadge.findUnique({
        where: { userId },
        select: { id: true, expiresAt: true, status: true },
      });

      const baseDate = (existingBadge && existingBadge.status === 'ACTIVE' && existingBadge.expiresAt > new Date())
        ? existingBadge.expiresAt
        : new Date();

      const expiresAt = new Date(baseDate);
      expiresAt.setDate(expiresAt.getDate() + plan.durationDays);

      if (existingBadge) {
        // Extend existing badge
        await prisma.$transaction([
          prisma.superBadge.update({
            where: { id: existingBadge.id },
            data: {
              planId: plan.id,
              expiresAt,
              status: 'ACTIVE',
              paymentMethod: 'WALLET',
              receiptUrl: null,
            },
          }),
          prisma.user.update({
            where: { id: userId },
            data: { walletBalance: { decrement: plan.price } },
          }),
          prisma.walletTransaction.create({
            data: {
              userId,
              amount: plan.price,
              type: 'BADGE_PURCHASE',
              description: `Super Badge extended — ${plan.name}`,
            },
          }),
        ]);
      } else {
        // Create new badge and activate
        await prisma.$transaction([
          prisma.superBadge.create({
            data: {
              userId,
              planId: plan.id,
              status: 'ACTIVE',
              expiresAt,
              paymentMethod: 'WALLET',
            },
          }),
          prisma.user.update({
            where: { id: userId },
            data: { walletBalance: { decrement: plan.price } },
          }),
          prisma.walletTransaction.create({
            data: {
              userId,
              amount: plan.price,
              type: 'BADGE_PURCHASE',
              description: `Super Badge purchased — ${plan.name}`,
            },
          }),
        ]);
      }

      await dispatchNotification(
        userId,
        'badge_activated',
        '🏅 Super Badge Activated!',
        `Your Super Badge is now active until ${expiresAt.toLocaleDateString()}. Enjoy unlimited previews & saveable videos!`
      );

      res.json({
        success: true,
        message: existingBadge ? 'Super Badge extended successfully' : 'Super Badge activated!',
        data: { expiresAt },
      });
      return;
    }

    // ── Bank / Crypto / Binance payment: upload receipt and set to PENDING_PAYMENT ──────────────
    if (paymentMethod !== 'WALLET') {
      let receiptUrl: string | null = null;
      if (paymentMethod === 'BANK' || paymentMethod === 'BINANCE') {
        if (!req.file) {
          res.status(400).json({ success: false, message: 'Receipt is required' });
          return;
        }
        receiptUrl = await uploadReceipt(
          req.file.buffer,
          `badge-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`
        );
      } else if (paymentMethod === 'CRYPTO') {
        const { txHash } = req.body;
        if (!txHash) {
          res.status(400).json({ success: false, message: 'TX Hash is required for Crypto' });
          return;
        }
        receiptUrl = `CRYPTO_TXID:${txHash}`;
      }

      // Check if they already have an active/pending badge
      const existingBadge = await prisma.superBadge.findUnique({
        where: { userId },
      });

      if (existingBadge) {
        if (existingBadge.status === 'PENDING_PAYMENT') {
          // Overwrite the existing pending request
          await prisma.superBadge.update({
            where: { id: existingBadge.id },
            data: { planId: plan.id, paymentMethod, receiptUrl },
          });
        } else if (existingBadge.status === 'ACTIVE') {
          res.status(400).json({ success: false, message: 'Cannot extend an active badge via Bank/Crypto yet. Please wait until it expires or use Wallet.' });
          return;
        }
      } else {
        await prisma.superBadge.create({
          data: {
            userId,
            planId: plan.id,
            status: 'PENDING_PAYMENT',
            expiresAt: new Date(0), // Placeholder until confirmed
            paymentMethod: paymentMethod as any, // Cast to any to handle schema enum issues safely for now
            receiptUrl,
          },
        });
      }

      // Notify admins
      await dispatchNotification(
        null, // Global to admins
        'system',
        '💳 New Badge Purchase',
        `A user purchased ${plan.name} via ${paymentMethod}. Please verify the receipt.`
      );

      res.json({ success: true, message: 'Payment submitted for review.' });
      return;
    }
  } catch (error) {
    console.error('[purchaseBadge]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/badge/admin/confirm/:badgeId   [ADMIN]
// Admin confirms a PENDING_PAYMENT badge → activates it
// ─────────────────────────────────────────────────────────────────────────────
export const adminConfirmBadge = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const badgeId = req.params.badgeId as string;

    const badge = await prisma.superBadge.findUnique({
      where: { id: badgeId },
      include: { plan: { select: { name: true, durationDays: true } }, user: { select: { id: true, walletBalance: true } } },
    });

    if (!badge) {
      res.status(404).json({ success: false, message: 'Badge not found' });
      return;
    }

    if (badge.status !== 'PENDING_PAYMENT') {
      res.status(400).json({ success: false, message: `Badge is already ${badge.status}` });
      return;
    }

    // Recalculate expiry from now (in case it was pending for a long time)
    const expiresAt = new Date();
    const planDurationDays = (badge as any).plan?.durationDays ?? 30;
    expiresAt.setDate(expiresAt.getDate() + planDurationDays);

    await prisma.superBadge.update({
      where: { id: badgeId },
      data: { expiresAt },
    });

    await activateBadge(badgeId, badge.userId);

    await dispatchNotification(
      badge.userId,
      'badge_activated',
      '🏅 Super Badge Activated!',
      `Your Super Badge payment was confirmed! Badge active until ${expiresAt.toLocaleDateString()}. Enjoy unlimited previews & saveable videos!`
    );

    res.json({
      success: true,
      message: 'Badge confirmed and activated',
      data: { expiresAt },
    });
  } catch (error) {
    console.error('[adminConfirmBadge]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/badge/admin/reject/:badgeId    [ADMIN]
// Admin rejects a PENDING_PAYMENT badge — deletes it so user can retry
// ─────────────────────────────────────────────────────────────────────────────
export const adminRejectBadge = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const badgeId = req.params.badgeId as string;

    const badge = await prisma.superBadge.findUnique({
      where: { id: badgeId },
      select: { status: true, userId: true },
    });

    if (!badge) {
      res.status(404).json({ success: false, message: 'Badge not found' });
      return;
    }

    if (badge.status !== 'PENDING_PAYMENT') {
      res.status(400).json({ success: false, message: 'Can only reject PENDING_PAYMENT badges' });
      return;
    }

    await prisma.superBadge.delete({ where: { id: badgeId } });

    await dispatchNotification(
      badge.userId,
      'badge_rejected',
      '❌ Super Badge Payment Rejected',
      'Your Super Badge payment receipt was rejected. Please contact support or try again with a valid receipt.'
    );

    res.json({ success: true, message: 'Badge rejected and deleted' });
  } catch (error) {
    console.error('[adminRejectBadge]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/badge/admin/:id             [ADMIN]
// Delete a badge holder (revoke badge)
// ─────────────────────────────────────────────────────────────────────────────
export const adminDeleteBadgeHolder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const badge = await prisma.superBadge.findUnique({ where: { id } });
    if (!badge) {
      res.status(404).json({ success: false, message: 'Badge not found' });
      return;
    }

    await prisma.superBadge.delete({ where: { id } });

    res.json({ success: true, message: 'Badge revoked and deleted' });
  } catch (error) {
    console.error('[adminDeleteBadgeHolder]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/badge/admin/list               [ADMIN]
// List all badge holders (active + pending)
// ─────────────────────────────────────────────────────────────────────────────
export const adminListBadges = async (_req: Request, res: Response): Promise<void> => {
  try {
    const badges = await prisma.superBadge.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, firstName: true, telegramUsername: true, photoUrl: true } },
        plan: { select: { name: true, durationDays: true, price: true } },
      },
    });

    const formattedBadges = await Promise.all(badges.map(async (badge) => ({
      ...badge,
      user: {
        ...badge.user,
        photoUrl: await resolveTgFileUrl(badge.user.photoUrl || null)
      }
    })));

    res.json({ success: true, data: formattedBadges });
  } catch (error) {
    console.error('[adminListBadges]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin: CRUD for badge plans
// ─────────────────────────────────────────────────────────────────────────────
export const adminGetPlans = async (_req: Request, res: Response): Promise<void> => {
  try {
    const plans = await prisma.superBadgePlan.findMany({ orderBy: { order: 'asc' } });
    res.json({ success: true, data: plans });
  } catch (error) {
    console.error('[adminGetPlans]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adminCreatePlan = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, durationDays, price, order } = req.body;
    if (!name || !durationDays || !price) {
      res.status(400).json({ success: false, message: 'name, durationDays, price are required' });
      return;
    }
    const plan = await prisma.superBadgePlan.create({
      data: { name, durationDays: Number(durationDays), price: Number(price), order: Number(order ?? 0) },
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[adminCreatePlan]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adminUpdatePlan = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { name, durationDays, price, order, isActive } = req.body;
    const plan = await prisma.superBadgePlan.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(durationDays !== undefined && { durationDays: Number(durationDays) }),
        ...(price !== undefined && { price: Number(price) }),
        ...(order !== undefined && { order: Number(order) }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[adminUpdatePlan]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adminDeletePlan = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    
    const badgesCount = await prisma.superBadge.count({ where: { planId: id } });
    if (badgesCount > 0) {
      res.status(400).json({ 
        success: false, 
        message: 'Cannot delete plan because it is currently in use by users. Please deactivate it instead.' 
      });
      return;
    }

    await prisma.superBadgePlan.delete({ where: { id } });
    res.json({ success: true, message: 'Plan deleted' });
  } catch (error) {
    console.error('[adminDeletePlan]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
