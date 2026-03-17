import { Router } from 'express';
import * as publicController from '../controllers/public.controller';
import * as pdfController from '../controllers/pdf.controller';

const router = Router();

// Special Bot Collections (Trending Videos)
router.get('/special-collections', publicController.getPublicSpecialCollections);

// Free PDFs
router.get('/pdf-categories', pdfController.getPublicPdfCategories);
router.get('/pdf-series/:subcategorySlug', pdfController.getPublicPdfSeries);
router.get('/pdfs/:seriesSlug', pdfController.getPublicPdfs);

export default router;
