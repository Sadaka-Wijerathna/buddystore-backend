import { Router } from 'express';
import * as publicController from '../controllers/public.controller';
import * as pdfController from '../controllers/pdf.controller';
import { authenticate } from '../middleware/auth.middleware';


const router = Router();

// Special Bot Collections (Trending Videos) — public list
router.get('/settings', publicController.getPublicSettings);
router.get('/categories', publicController.getPublicCategories);
router.get('/special-collections', publicController.getPublicSpecialCollections);
router.get('/special-collections/:slug', publicController.getPublicSpecialCollectionBySlug);

// Bank Accounts — public list (for checkout)
router.get('/bank-accounts', publicController.getPublicBankAccounts);

// Video Gallery — requires auth (logged-in users only)
router.get('/video-gallery', authenticate, publicController.getVideoGallery);
// Paginated thumbnails for a single category (used by the browse modal)
router.get('/video-gallery/:category/thumbnails', authenticate, publicController.getCategoryThumbnails);
// Rate limited preview endpoints
router.get('/video-gallery/preview-quota', authenticate, publicController.getPreviewQuota);
router.post('/video-gallery/preview-request', authenticate, publicController.requestVideoPreview);

// Free PDFs
router.get('/pdf-categories', pdfController.getPublicPdfCategories);
router.get('/pdf-series/:subcategorySlug', pdfController.getPublicPdfSeries);
router.get('/pdf-series/category/:categorySlug', pdfController.getPublicPdfSeriesByCategory);
router.get('/pdfs/download/:id', pdfController.downloadFreePdf);
router.get('/pdfs/:seriesSlug', pdfController.getPublicPdfs);

export default router;
