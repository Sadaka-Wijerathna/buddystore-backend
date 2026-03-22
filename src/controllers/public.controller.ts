import { Request, Response } from 'express';
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
        description: c.description,
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

// ─── Category label map ────────────────────────────────────────────────────────
const CATEGORY_LABELS: Record<string, string> = {
  MIXED:      'Mixed',
  MOM_SON:    'Mom & Son',
  SRI_LANKAN: 'Sri Lankan',
  CCTV:       'CCTV & Hidden Cam',
  PUBLIC:     'Public',
  RAPE:       'Rape',
};

// GET /api/v1/public/video-gallery  (requires auth)
// Returns category-grouped thumbnail data for the gallery page.
export const getVideoGallery = async (_req: Request, res: Response): Promise<void> => {
  try {
    // Get all categories that have at least one thumbnail
    const categoriesWithThumbnails = await prisma.videos.groupBy({
      by: ['category'],
      where: { thumbnailUrl: { not: null } },
      _count: { fileId: true },
    });

    // For each category fetch up to 12 sample thumbnails and total video count
    const data = await Promise.all(
      categoriesWithThumbnails.map(async (group) => {
        const thumbnailRows = await prisma.videos.findMany({
          where: {
            category: group.category,
            thumbnailUrl: { not: null },
          },
          select: { thumbnailUrl: true, collectedAt: true },
          take: 200,
          orderBy: { collectedAt: 'desc' },
        });

        // Total video count for this category (not just those with thumbnails)
        const totalVideos = await prisma.videos.count({
          where: { category: group.category },
        });

        return {
          category: group.category,
          label: CATEGORY_LABELS[group.category] ?? group.category,
          totalVideos,
          thumbnails: thumbnailRows.map(r => ({
            url: r.thumbnailUrl as string,
            collectedAt: r.collectedAt.toISOString(),
          })),
        };
      })
    );

    res.json({ success: true, data });
  } catch (error) {
    console.error('[getVideoGallery]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
