import { Router } from 'express';
import * as pdfController from '../controllers/pdf.controller';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';
import upload from '../middleware/upload.middleware';

const router = Router();

// ─── Admin routes (auth + admin required) ─────────────────────────────────────
router.use(authenticate, requireAdmin);

// Categories
router.get('/pdf-categories', pdfController.getAdminPdfCategories);
router.post('/pdf-categories', pdfController.createPdfCategory);
router.delete('/pdf-categories/:id', pdfController.deletePdfCategory);

// Subcategories
router.post('/pdf-subcategories', pdfController.createPdfSubCategory);
router.delete('/pdf-subcategories/:id', pdfController.deletePdfSubCategory);

// Series
router.get('/pdf-series', pdfController.getAdminPdfSeries);
router.post('/pdf-series', upload.single('banner'), pdfController.createPdfSeries);
router.delete('/pdf-series/:id', pdfController.deletePdfSeries);

// PDFs
router.get('/pdfs', pdfController.getAdminPdfs);
router.post('/pdfs', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 50 }]), pdfController.uploadFreePdf);
router.delete('/pdfs/:id', pdfController.deleteFreePdf);

export default router;
