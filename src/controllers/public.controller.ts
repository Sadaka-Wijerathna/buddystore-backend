import { Request, Response } from 'express';
import https from 'https';
import http from 'http';
import prisma from '../lib/prisma';
import { specialBot } from '../bots/special.bot';
import config from '../config';

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

// GET /api/v1/public/special-collections/:slug/videos?page=1&limit=20
// Returns paginated list of video IDs for the streaming player
export const getCollectionVideos = async (req: Request, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;
    const page  = Math.max(1, parseInt(String(Array.isArray(req.query.page)  ? req.query.page[0]  : (req.query.page  ?? '1')), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(Array.isArray(req.query.limit) ? req.query.limit[0] : (req.query.limit ?? '20')), 10) || 20));
    const skip  = (page - 1) * limit;

    const collection = await prisma.specialCollection.findUnique({ where: { slug: String(slug) } });
    if (!collection) {
      res.status(404).json({ success: false, message: 'Collection not found' });
      return;
    }

    const [videos, total] = await Promise.all([
      prisma.specialVideo.findMany({
        where: { collectionId: collection.id },
        orderBy: { collectedAt: 'asc' },
        skip,
        take: limit,
        select: { id: true, collectedAt: true },
      }),
      prisma.specialVideo.count({ where: { collectionId: collection.id } }),
    ]);

    res.json({
      success: true,
      data: {
        collectionId: collection.id,
        collectionTitle: collection.title,
        videos: videos.map((v, i) => ({
          id: v.id,
          number: skip + i + 1,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[getCollectionVideos]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/special-collections/:slug/videos/:videoId/stream
// Proxies the video bytes from Telegram CDN with Range support (needed for seeking)
export const streamCollectionVideo = async (req: Request, res: Response): Promise<void> => {
  try {
    const { slug, videoId } = req.params;

    // Resolve collection
    const collection = await prisma.specialCollection.findUnique({ where: { slug: String(slug) } });
    if (!collection) {
      res.status(404).json({ success: false, message: 'Collection not found' });
      return;
    }

    // Resolve video
    const video = await prisma.specialVideo.findFirst({
      where: { id: String(videoId), collectionId: String(collection.id) },
    });
    if (!video) {
      res.status(404).json({ success: false, message: 'Video not found' });
      return;
    }

    // Get a fresh Telegram CDN file URL
    if (!specialBot) {
      res.status(503).json({ success: false, message: 'Bot not configured' });
      return;
    }

    const fileInfo = await specialBot.api.getFile(video.fileId);
    if (!fileInfo.file_path) {
      res.status(502).json({ success: false, message: 'Could not get file path from Telegram' });
      return;
    }

    const token = config.bots.special;
    const telegramUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const fileSize = fileInfo.file_size;

    // Forward Range header from client (for video seeking)
    const rangeHeader = req.headers['range'];

    const telegramReqOptions: https.RequestOptions = {
      headers: rangeHeader ? { Range: rangeHeader } : {},
    };

    const protocol = telegramUrl.startsWith('https') ? https : http;

    const telegramReq = protocol.get(telegramUrl, telegramReqOptions, (telegramRes) => {
      const statusCode = telegramRes.statusCode ?? 200;
      const contentType = telegramRes.headers['content-type'] ?? 'video/mp4';
      const contentLength = telegramRes.headers['content-length'];
      const contentRange = telegramRes.headers['content-range'];

      const responseHeaders: Record<string, string | number> = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };

      if (contentLength) responseHeaders['Content-Length'] = contentLength;
      if (contentRange) responseHeaders['Content-Range'] = contentRange;
      if (fileSize && !contentLength) responseHeaders['Content-Length'] = fileSize;

      res.writeHead(statusCode, responseHeaders);
      telegramRes.pipe(res);

      telegramRes.on('error', (err) => {
        console.error('[streamCollectionVideo] Telegram stream error:', err);
        if (!res.headersSent) res.destroy();
      });
    });

    telegramReq.on('error', (err) => {
      console.error('[streamCollectionVideo] Telegram request error:', err);
      if (!res.headersSent) {
        res.status(502).json({ success: false, message: 'Failed to fetch video from Telegram' });
      }
    });

    // If the client disconnects, abort the upstream request
    req.on('close', () => {
      telegramReq.destroy();
    });

  } catch (error) {
    console.error('[streamCollectionVideo]', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
};
