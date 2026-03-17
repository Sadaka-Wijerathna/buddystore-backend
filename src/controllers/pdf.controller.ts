import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { uploadBanner, uploadPdf } from '../lib/cloudinary';

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/public/pdf-categories
// Returns all categories with their subcategories
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
// Returns all series for a given subcategory slug, with PDF count
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
      include: {
        _count: { select: { pdfs: true } },
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
        updatedAt: s.updatedAt,
      })),
    });
  } catch (error) {
    console.error('[getPublicPdfSeries]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/public/pdfs/:seriesSlug
// Returns all PDFs for a given series slug
export const getPublicPdfs = async (req: Request, res: Response): Promise<void> => {
  try {
    const seriesSlug = String(req.params.seriesSlug);

    const series = await prisma.pdfSeries.findUnique({
      where: { slug: seriesSlug },
      include: {
        pdfs: {
          orderBy: { order: 'asc' },
        },
      },
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
        pdfs: series.pdfs.map((p: { id: string; title: string; fileUrl: string; fileSize: string | null; order: number }) => ({
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

// GET /api/v1/admin/pdf-categories
export const getAdminPdfCategories = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const categories = await prisma.pdfCategory.findMany({
      orderBy: { order: 'asc' },
      include: {
        subcategories: {
          orderBy: { order: 'asc' },
          include: {
            _count: { select: { series: true } },
          },
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

// POST /api/v1/admin/pdf-categories  { slug, title, order? }
export const createPdfCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { slug, title, order } = req.body as { slug: string; title: string; order?: number };

    if (!slug || !title) {
      res.status(400).json({ success: false, message: 'slug and title are required' });
      return;
    }
    if (!/^[a-z0-9_]+$/.test(slug)) {
      res.status(400).json({ success: false, message: 'slug must be lowercase letters, numbers, and underscores only' });
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
    console.error('[createPdfCategory]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /api/v1/admin/pdf-categories/:id
export const deletePdfCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    await prisma.pdfCategory.delete({ where: { id } });
    res.json({ success: true, message: 'Category deleted' });
  } catch (error) {
    console.error('[deletePdfCategory]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — Subcategories
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/v1/admin/pdf-subcategories  { slug, title, categoryId, order? }
export const createPdfSubCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { slug, title, categoryId, order } = req.body as {
      slug: string; title: string; categoryId: string; order?: number;
    };

    if (!slug || !title || !categoryId) {
      res.status(400).json({ success: false, message: 'slug, title, and categoryId are required' });
      return;
    }
    if (!/^[a-z0-9_]+$/.test(slug)) {
      res.status(400).json({ success: false, message: 'slug must be lowercase letters, numbers, and underscores only' });
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
    console.error('[createPdfSubCategory]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /api/v1/admin/pdf-subcategories/:id
export const deletePdfSubCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    await prisma.pdfSubCategory.delete({ where: { id } });
    res.json({ success: true, message: 'Subcategory deleted' });
  } catch (error) {
    console.error('[deletePdfSubCategory]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — Series
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/admin/pdf-series?subcategoryId=xxx
export const getAdminPdfSeries = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { subcategoryId } = req.query;

    const where = subcategoryId ? { subcategoryId: String(subcategoryId) } : {};

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
    console.error('[getAdminPdfSeries]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/admin/pdf-series  (multipart: slug, title, description?, subcategoryId, banner?)
export const createPdfSeries = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { slug, title, description, subcategoryId } = req.body as {
      slug: string; title: string; description?: string; subcategoryId: string;
    };

    if (!slug || !title || !subcategoryId) {
      res.status(400).json({ success: false, message: 'slug, title, and subcategoryId are required' });
      return;
    }
    if (!/^[a-z0-9_]+$/.test(slug)) {
      res.status(400).json({ success: false, message: 'slug must be lowercase letters, numbers, and underscores only' });
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
    console.error('[createPdfSeries]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /api/v1/admin/pdf-series/:id
export const deletePdfSeries = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    await prisma.pdfSeries.delete({ where: { id } });
    res.json({ success: true, message: 'Series deleted' });
  } catch (error) {
    console.error('[deletePdfSeries]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — PDFs
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/admin/pdfs?seriesId=xxx
export const getAdminPdfs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { seriesId } = req.query;

    if (!seriesId) {
      res.status(400).json({ success: false, message: 'seriesId query param is required' });
      return;
    }

    const pdfs = await prisma.freePdf.findMany({
      where: { seriesId: String(seriesId) },
      orderBy: { order: 'asc' },
    });

    res.json({ success: true, data: pdfs });
  } catch (error) {
    console.error('[getAdminPdfs]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/admin/pdfs  (multipart: title, seriesId, order?, file)
export const uploadFreePdf = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, seriesId, order } = req.body as {
      title: string; seriesId: string; order?: string;
    };

    if (!title || !seriesId) {
      res.status(400).json({ success: false, message: 'title and seriesId are required' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, message: 'PDF file is required' });
      return;
    }

    if (req.file.mimetype !== 'application/pdf') {
      res.status(400).json({ success: false, message: 'Only PDF files are allowed' });
      return;
    }

    // Calculate file size string
    const bytes = req.file.size;
    let fileSize: string;
    if (bytes >= 1024 * 1024) {
      fileSize = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else {
      fileSize = `${Math.round(bytes / 1024)} KB`;
    }

    // Upload to Cloudinary
    const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const filename = `pdf-${seriesId}-${safeTitle}-${Date.now()}`;
    const fileUrl = await uploadPdf(req.file.buffer, filename);

    // Determine order: if not provided, append after last
    let pdfOrder = 0;
    if (order !== undefined && order !== '') {
      pdfOrder = parseInt(order, 10) || 0;
    } else {
      const last = await prisma.freePdf.findFirst({
        where: { seriesId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      pdfOrder = (last?.order ?? -1) + 1;
    }

    const pdf = await prisma.freePdf.create({
      data: { title, fileUrl, fileSize, seriesId, order: pdfOrder },
    });

    res.status(201).json({ success: true, data: pdf });
  } catch (error) {
    console.error('[uploadFreePdf]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /api/v1/admin/pdfs/:id
export const deleteFreePdf = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    await prisma.freePdf.delete({ where: { id } });
    res.json({ success: true, message: 'PDF deleted' });
  } catch (error) {
    console.error('[deleteFreePdf]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
