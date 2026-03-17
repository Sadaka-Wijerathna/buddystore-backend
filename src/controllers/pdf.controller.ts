import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { uploadBanner, uploadPdf } from '../lib/cloudinary';

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/public/pdf-categories
export const getPublicPdfCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const categories = await prisma.pdfCategory.findMany({
      orderBy: { order: 'asc' },
      include: {
        subcategories: {
          orderBy: { order: 'asc' },
        },
      },
    });
    res.json({ success: true, data: categories });
  } catch (error) {
    console.error('[getPublicPdfCategories]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/pdf-series/:subcategorySlug
export const getPublicPdfSeries = async (req: Request, res: Response): Promise<void> => {
  try {
    const subcategorySlug = String(req.params.subcategorySlug);
    const subcategory = await prisma.pdfSubCategory.findUnique({
      where: { slug: subcategorySlug },
    });
    if (!subcategory) {
      res.status(404).json({ success: false, message: 'Subcategory not found' });
      return;
    }
    const series = await prisma.pdfSeries.findMany({
      where: { subcategoryId: subcategory.id },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { pdfs: true } } },
    });
    res.json({
      success: true,
      data: series.map((s) => ({
        id: s.id,
        slug: s.slug,
        title: s.title,
        description: s.description,
        bannerUrl: s.bannerUrl,
        pdfCount: s._count.pdfs,
        updatedAt: s.updatedAt,
      })),
    });
  } catch (error) {
    console.error('[getPublicPdfSeries]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/pdfs/:seriesSlug
export const getPublicPdfs = async (req: Request, res: Response): Promise<void> => {
  try {
    const seriesSlug = String(req.params.seriesSlug);
    const series = await prisma.pdfSeries.findUnique({
      where: { slug: seriesSlug },
      include: { pdfs: { orderBy: { order: 'asc' } } },
    });
    if (!series) {
      res.status(404).json({ success: false, message: 'Series not found' });
      return;
    }
    res.json({
      success: true,
      data: {
        id: series.id,
        slug: series.slug,
        title: series.title,
        description: series.description,
        bannerUrl: series.bannerUrl,
        pdfs: series.pdfs.map((p) => ({
          id: p.id,
          title: p.title,
          fileUrl: p.fileUrl,
          fileSize: p.fileSize,
          order: p.order,
        })),
      },
    });
  } catch (error) {
    console.error('[getPublicPdfs]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — Categories
// ═══════════════════════════════════════════════════════════════════════════════

export const getAdminPdfCategories = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const categories = await prisma.pdfCategory.findMany({
      orderBy: { order: 'asc' },
      include: {
        subcategories: {
          orderBy: { order: 'asc' },
          include: { _count: { select: { series: true } } },
        },
        _count: { select: { subcategories: true } },
      },
    });
    res.json({ success: true, data: categories });
  } catch (error) {
    console.error('[getAdminPdfCategories]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createPdfCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { slug, title, order } = req.body;
    if (!slug || !title) {
      res.status(400).json({ success: false, message: 'slug and title are required' });
      return;
    }
    const category = await prisma.pdfCategory.create({
      data: { slug, title, order: order ?? 0 },
    });
    res.status(201).json({ success: true, data: category });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ success: false, message: 'A category with this slug already exists' });
      return;
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deletePdfCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ success: false, message: 'Invalid category ID' });
      return;
    }
    await prisma.pdfCategory.delete({ where: { id } });
    res.json({ success: true, message: 'Category deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — Subcategories
// ═══════════════════════════════════════════════════════════════════════════════

export const createPdfSubCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { slug, title, categoryId, order } = req.body;
    if (!slug || !title || !categoryId) {
      res.status(400).json({ success: false, message: 'slug, title, and categoryId are required' });
      return;
    }
    const subcategory = await prisma.pdfSubCategory.create({
      data: { slug, title, categoryId, order: order ?? 0 },
    });
    res.status(201).json({ success: true, data: subcategory });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ success: false, message: 'A subcategory with this slug already exists' });
      return;
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deletePdfSubCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ success: false, message: 'Invalid subcategory ID' });
      return;
    }
    await prisma.pdfSubCategory.delete({ where: { id } });
    res.json({ success: true, message: 'Subcategory deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — Series
// ═══════════════════════════════════════════════════════════════════════════════

export const getAdminPdfSeries = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const subcategoryId = req.query.subcategoryId ? String(req.query.subcategoryId) : undefined;
    const where: { subcategoryId?: string } = subcategoryId ? { subcategoryId } : {};
    const series = await prisma.pdfSeries.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { pdfs: true } },
        subcategory: { select: { title: true, slug: true } },
      },
    });
    res.json({
      success: true,
      data: series.map((s) => ({
        id: s.id,
        slug: s.slug,
        title: s.title,
        description: s.description,
        bannerUrl: s.bannerUrl,
        pdfCount: s._count.pdfs,
        subcategory: s.subcategory,
        updatedAt: s.updatedAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createPdfSeries = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { slug, title, description, subcategoryId } = req.body;
    if (!slug || !title || !subcategoryId) {
      res.status(400).json({ success: false, message: 'slug, title, and subcategoryId are required' });
      return;
    }
    let bannerUrl: string | null = null;
    if (req.file) {
      const filename = `pdf-series-${slug}-${Date.now()}`;
      bannerUrl = await uploadBanner(req.file.buffer, filename);
    }
    const series = await prisma.pdfSeries.create({
      data: { slug, title, description, subcategoryId, bannerUrl },
    });
    res.status(201).json({ success: true, data: { ...series, pdfCount: 0 } });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ success: false, message: 'A series with this slug already exists' });
      return;
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deletePdfSeries = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ success: false, message: 'Invalid series ID' });
      return;
    }
    await prisma.pdfSeries.delete({ where: { id } });
    res.json({ success: true, message: 'Series deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — PDFs
// ═══════════════════════════════════════════════════════════════════════════════

export const getAdminPdfs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const seriesId = req.query.seriesId ? String(req.query.seriesId) : undefined;
    if (!seriesId) {
      res.status(400).json({ success: false, message: 'seriesId is required' });
      return;
    }
    const pdfs = await prisma.freePdf.findMany({
      where: { seriesId },
      orderBy: { order: 'asc' },
    });
    res.json({ success: true, data: pdfs });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const uploadFreePdf = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { seriesId, title, titles } = req.body;
    // titles is a JSON-encoded array for bulk
    const parsedTitles: string[] = titles ? JSON.parse(titles) : [];
    
    // Cast to handle upload.fields or upload.array
    const multerFiles = req.files as { [fieldname: string]: Express.Multer.File[] } | Express.Multer.File[] | undefined;
    
    let allFiles: Express.Multer.File[] = [];
    if (Array.isArray(multerFiles)) {
        allFiles = multerFiles;
    } else if (multerFiles) {
        allFiles = [...(multerFiles['files'] || []), ...(multerFiles['file'] || [])];
    } else if (req.file) {
        allFiles = [req.file];
    }

    if (!seriesId || allFiles.length === 0) {
      res.status(400).json({ success: false, message: 'seriesId and at least one file are required' });
      return;
    }

    // Get current max order to append after
    const last = await prisma.freePdf.findFirst({
      where: { seriesId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    let nextOrder = (last?.order ?? -1) + 1;

    const results = [];
    for (let i = 0; i < allFiles.length; i++) {
        const file = allFiles[i];
        if (file.mimetype !== 'application/pdf') continue;

        // Use title from parsedTitles, or the 'title' field (for single), or filename
        const currentTitle = parsedTitles[i] || title || file.originalname.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();

        // Standard direct public_id logic
        // Use only the subfolder part, as 'buddystore/pdfs' is handle by the library
        const safeTitle = currentTitle.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50);
        const filename = `${seriesId}/${safeTitle}_${Date.now()}.pdf`;
        const fileUrl = await uploadPdf(file.buffer, filename);
        
        const bytes = file.size;
        const fileSize = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

        const pdf = await prisma.freePdf.create({
          data: { title: currentTitle, fileUrl, fileSize, seriesId, order: nextOrder++ },
        });
        results.push(pdf);
    }

    res.status(201).json({ 
        success: true, 
        data: results.length === 1 ? results[0] : results 
    });
  } catch (error) {
    console.error('[uploadFreePdf]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deleteFreePdf = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ success: false, message: 'Invalid PDF ID' });
      return;
    }
    await prisma.freePdf.delete({ where: { id } });
    res.json({ success: true, message: 'PDF deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
}
