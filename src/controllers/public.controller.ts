import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';

// GET /api/v1/public/special-collections
export const getPublicSpecialCollections = async (_req: Request, res: Response): Promise<void> => {
  try {
    const collections = await prisma.specialCollection.findMany({
      orderBy: [
        { order: 'desc' },
        { createdAt: 'desc' },
      ] as any[],
    });

    res.json({
      success: true,
      data: collections.map(c => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        keywords: c.keywords,
        banner: c.banner,
        totalVideos: c.totalVideos,
        createdAt: c.createdAt,
      })),
    });
  } catch (error) {
    console.error('[getPublicSpecialCollections]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/video-gallery  (requires auth)
// Returns category cards with the first 50 thumbnails each (for the preview mosaic).
export const getVideoGallery = async (req: Request, res: Response): Promise<void> => {
  try {
    const categoriesWithThumbnails = await prisma.videos.groupBy({
      by: ['category'],
      where: { thumbnailUrl: { not: null } },
      _count: { fileId: true },
    });

    // Build a label map from the bots table so custom categories get the right display name
    const allBots = await prisma.bot.findMany({ select: { category: true, label: true, bannerUrl: true, showPreviews: true } });
    const labelMap: Record<string, string> = {};
    const bannerMap: Record<string, string | null> = {};
    const previewAccessMap: Record<string, boolean> = {};
    allBots.forEach(b => {
      labelMap[b.category] = b.label || b.category;
      bannerMap[b.category] = b.bannerUrl;
      previewAccessMap[b.category] = b.showPreviews;
    });

    const data = await Promise.all(
      categoriesWithThumbnails.map(async (group) => {
        if (!previewAccessMap[group.category]) return null;

        const [totalVideos, totalWithThumbnail] = await Promise.all([
          prisma.videos.count({ where: { category: group.category } }),
          prisma.videos.count({ where: { category: group.category, thumbnailUrl: { not: null } } }),
        ]);

        const thumbnailRows = await prisma.videos.findMany({
          where: { category: group.category, thumbnailUrl: { not: null } },
          select: { thumbnailUrl: true, collectedAt: true },
          take: 50,
          orderBy: { collectedAt: 'desc' },
        });

        // If zero actual thumbnails exist, skip this category entirely
        if (thumbnailRows.length === 0) return null;

        return {
          category: group.category,
          label: labelMap[group.category] ?? group.category,
          totalVideos,
          totalWithThumbnail,
          bannerUrl: bannerMap[group.category] ?? null,
          isLocked: false,
          thumbnails: thumbnailRows.map(r => ({
            url: r.thumbnailUrl as string,
            collectedAt: r.collectedAt.toISOString(),
          })),
        };
      })
    );

    // Remove any nulls (categories with no thumbnails)
    const filtered = data.filter(Boolean);
    res.json({ success: true, data: filtered });
  } catch (error) {
    console.error('[getVideoGallery]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/categories
// Returns all categories that have an active bot configured.
// Used by the packages page to build a dynamic category list.
export const getPublicCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const bots = await prisma.bot.findMany({
      select: {
        category: true,
        label: true,
        name: true,
        minVideoCount: true,
        pricePerVideo: true,
        totalVideos: true,
        collectionMode: true,
      },
      orderBy: { category: 'asc' },
    });

    res.json({
      success: true,
      data: bots.map(b => ({
        category: b.category,
        label: b.label || b.category,
        botHandle: `@${b.name}`,
        minVideoCount: b.minVideoCount,
        pricePerVideo: b.pricePerVideo,
        totalVideos: b.totalVideos,
        collectionMode: b.collectionMode,
      })),
    });
  } catch (error) {
    console.error('[getPublicCategories]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/video-gallery/:category/thumbnails?page=1&limit=100 (requires auth)
// Paginated thumbnail loader for the full-gallery modal.
export const getCategoryThumbnails = async (req: Request, res: Response): Promise<void> => {
  try {
    const category = req.params.category as string;
    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'),  10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    const skip  = (page - 1) * limit;

    const [thumbnailRows, total, bot] = await Promise.all([
      prisma.videos.findMany({
        where: { category: category as any, thumbnailUrl: { not: null } },
        select: { id: true, thumbnailUrl: true, collectedAt: true },
        orderBy: { collectedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.videos.count({
        where: { category: category as any, thumbnailUrl: { not: null } },
      }),
      prisma.bot.findUnique({
        where: { category: category as any },
        select: { name: true }
      }),
    ]);

    res.json({
      success: true,
      data: {
        botUsername: bot?.name || 'BuddyStore_bot',
        thumbnails: thumbnailRows.map(r => ({
          id: r.id,
          url: r.thumbnailUrl as string,
          collectedAt: r.collectedAt.toISOString(),
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('[getCategoryThumbnails]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/bank-accounts
export const getPublicBankAccounts = async (_req: Request, res: Response): Promise<void> => {
  try {
    const accounts = await prisma.bankAccount.findMany({
      where: { isActive: true },
      orderBy: { order: 'asc' },
    });

    res.json({ success: true, data: accounts });
  } catch (error) {
    console.error('[getPublicBankAccounts]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/special-collections/:slug
export const getPublicSpecialCollectionBySlug = async (req: Request, res: Response): Promise<void> => {
  try {
    const slug = String(req.params.slug);
    const collection = await prisma.specialCollection.findUnique({
      where: { slug },
    });

    if (!collection) {
      res.status(404).json({ success: false, message: 'Collection not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        id: collection.id,
        slug: collection.slug,
        title: collection.title,
        keywords: collection.keywords,
        banner: collection.banner,
        trendingTag: collection.trendingTag,
        totalVideos: collection.totalVideos,
        createdAt: collection.createdAt,
      },
    });
  } catch (error) {
    console.error('[getPublicSpecialCollectionBySlug]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/settings
export const getPublicSettings = async (_req: Request, res: Response): Promise<void> => {
  try {
    const keys = ['TRENDING_BOT_USERNAME'];
    const settings = await prisma.setting.findMany({
      where: { key: { in: keys } }
    });

    const map: Record<string, string> = settings.reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {});
    
    // Default if not set
    if (!map['TRENDING_BOT_USERNAME']) {
      map['TRENDING_BOT_USERNAME'] = 'BuddySpecial1Bot';
    }

    res.json({ success: true, data: map });
  } catch (error) {
    console.error('[getPublicSettings]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/video-gallery/preview-quota
export const getPreviewQuota = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const LIMIT = 5;

    const quota = await prisma.previewQuota.findUnique({
      where: {
        userId_date: { userId, date: todayStr }
      }
    });

    const used = quota?.count || 0;
    res.json({ success: true, used, remaining: Math.max(0, LIMIT - used), limit: LIMIT });
  } catch (error) {
    console.error('[getPreviewQuota]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/public/video-gallery/preview-request
export const requestVideoPreview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const LIMIT = 5;

    // Use Prisma upsert to get or create today's quota
    const quota = await prisma.previewQuota.upsert({
      where: {
        userId_date: { userId, date: todayStr }
      },
      update: {},
      create: {
        userId,
        date: todayStr,
        count: 0
      }
    });

    if (quota.count >= LIMIT) {
      res.json({ success: false, allowed: false, remaining: 0, message: 'Daily limit reached' });
      return;
    }

    // Increment
    await prisma.previewQuota.update({
      where: { id: quota.id },
      data: { count: { increment: 1 } }
    });

    res.json({ success: true, allowed: true, remaining: LIMIT - (quota.count + 1) });
  } catch (error) {
    console.error('[requestVideoPreview]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
