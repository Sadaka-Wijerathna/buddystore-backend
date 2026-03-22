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
