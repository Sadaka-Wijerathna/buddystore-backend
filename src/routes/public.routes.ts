import { Router } from 'express';
import * as publicController from '../controllers/public.controller';
import * as pdfController from '../controllers/pdf.controller';
import { authenticate } from '../middleware/auth.middleware';


const router = Router();

// Special Bot Collections (Trending Videos) — public list
/**
 * @swagger
 * tags:
 *   name: Public
 *   description: Publicly accessible content
 */

/**
 * @swagger
 * /public/settings:
 *   get:
 *     summary: Get public settings
 *     tags: [Public]
 *     responses:
 *       200:
 *         description: Settings object
 */
router.get('/settings', publicController.getPublicSettings);

/**
 * @swagger
 * /public/categories:
 *   get:
 *     summary: Get public categories
 *     tags: [Public]
 *     responses:
 *       200:
 *         description: List of categories
 */
router.get('/categories', publicController.getPublicCategories);

/**
 * @swagger
 * /public/special-collections:
 *   get:
 *     summary: Get special collections
 *     tags: [Public]
 *     responses:
 *       200:
 *         description: List of special collections
 */
router.get('/special-collections', publicController.getPublicSpecialCollections);

/**
 * @swagger
 * /public/special-collections/{slug}:
 *   get:
 *     summary: Get special collection by slug
 *     tags: [Public]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Special collection details
 */
router.get('/special-collections/:slug', publicController.getPublicSpecialCollectionBySlug);

/**
 * @swagger
 * /public/bank-accounts:
 *   get:
 *     summary: Get active bank accounts
 *     tags: [Public]
 *     responses:
 *       200:
 *         description: List of bank accounts
 */
router.get('/bank-accounts', publicController.getPublicBankAccounts);

/**
 * @swagger
 * /public/video-gallery:
 *   get:
 *     summary: Get video gallery
 *     tags: [Public]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Video gallery
 */
router.get('/video-gallery', authenticate, publicController.getVideoGallery);

/**
 * @swagger
 * /public/video-gallery/{category}/thumbnails:
 *   get:
 *     summary: Get category thumbnails
 *     tags: [Public]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: category
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Thumbnails
 */
router.get('/video-gallery/:category/thumbnails', authenticate, publicController.getCategoryThumbnails);

/**
 * @swagger
 * /public/video-gallery/preview-quota:
 *   get:
 *     summary: Get preview quota
 *     tags: [Public]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Quota details
 */
router.get('/video-gallery/preview-quota', authenticate, publicController.getPreviewQuota);

/**
 * @swagger
 * /public/video-gallery/preview-request:
 *   post:
 *     summary: Request video preview
 *     tags: [Public]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Preview sent
 */
router.post('/video-gallery/preview-request', authenticate, publicController.requestVideoPreview);

/**
 * @swagger
 * /public/pdf-categories:
 *   get:
 *     summary: Get PDF categories
 *     tags: [Public]
 *     responses:
 *       200:
 *         description: PDF categories
 */
router.get('/pdf-categories', pdfController.getPublicPdfCategories);

/**
 * @swagger
 * /public/pdf-series/{subcategorySlug}:
 *   get:
 *     summary: Get PDF series by subcategory
 *     tags: [Public]
 *     parameters:
 *       - in: path
 *         name: subcategorySlug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: PDF series
 */
router.get('/pdf-series/:subcategorySlug', pdfController.getPublicPdfSeries);

/**
 * @swagger
 * /public/pdf-series/category/{categorySlug}:
 *   get:
 *     summary: Get PDF series by category
 *     tags: [Public]
 *     parameters:
 *       - in: path
 *         name: categorySlug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: PDF series
 */
router.get('/pdf-series/category/:categorySlug', pdfController.getPublicPdfSeriesByCategory);

/**
 * @swagger
 * /public/pdfs/download/{id}:
 *   get:
 *     summary: Download PDF
 *     tags: [Public]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: PDF file stream
 */
router.get('/pdfs/download/:id', pdfController.downloadFreePdf);

/**
 * @swagger
 * /public/pdfs/{seriesSlug}:
 *   get:
 *     summary: Get PDFs by series
 *     tags: [Public]
 *     parameters:
 *       - in: path
 *         name: seriesSlug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: PDFs list
 */
router.get('/pdfs/:seriesSlug', pdfController.getPublicPdfs);

export default router;
