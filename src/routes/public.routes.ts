import { Router } from 'express';
import * as publicController from '../controllers/public.controller';
import * as pdfController from '../controllers/pdf.controller';
import { authenticate } from '../middleware/auth.middleware';


const router = Router();

// Special Bot Collections (Trending Videos) — public list
router.get('/special-collections', publicController.getPublicSpecialCollections);

// Video Gallery — requires auth (logged-in users only)
router.get('/video-gallery', authenticate, publicController.getVideoGallery);

// Free PDFs
router.get('/pdf-categories', pdfController.getPublicPdfCategories);
router.get('/pdf-series/:subcategorySlug', pdfController.getPublicPdfSeries);
router.get('/pdfs/download/:id', pdfController.downloadFreePdf);
router.get('/pdfs/:seriesSlug', pdfController.getPublicPdfs);

export default router;
