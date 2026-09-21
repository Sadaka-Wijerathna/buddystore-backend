import { Router } from 'express';
import multer from 'multer';
import * as badge from '../controllers/badge.controller';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * @swagger
 * tags:
 *   name: Badges
 *   description: Super Badge subscription management
 */

/**
 * @swagger
 * /badge/plans:
 *   get:
 *     summary: Get available badge plans
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of badge plans
 */
router.get('/plans', authenticate, badge.getBadgePlans);

/**
 * @swagger
 * /badge/status:
 *   get:
 *     summary: Get current user's badge status
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Badge status
 */
router.get('/status', authenticate, badge.getBadgeStatus);

/**
 * @swagger
 * /badge/purchase:
 *   post:
 *     summary: Purchase a badge
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Badge purchased
 */
router.post('/purchase', authenticate, upload.single('receipt'), badge.purchaseBadge);

// ── Admin routes ──────────────────────────────────────────────────────────────
/**
 * @swagger
 * /badge/admin/list:
 *   get:
 *     summary: Admin list badges
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of badges
 */
router.get('/admin/list', authenticate, requireAdmin, badge.adminListBadges);

/**
 * @swagger
 * /badge/admin/plans:
 *   get:
 *     summary: Admin get plans
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of plans
 */
router.get('/admin/plans', authenticate, requireAdmin, badge.adminGetPlans);

/**
 * @swagger
 * /badge/admin/plans:
 *   post:
 *     summary: Admin create plan
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Plan created
 */
router.post('/admin/plans', authenticate, requireAdmin, badge.adminCreatePlan);

/**
 * @swagger
 * /badge/admin/plans/{id}:
 *   put:
 *     summary: Admin update plan
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Plan updated
 */
router.put('/admin/plans/:id', authenticate, requireAdmin, badge.adminUpdatePlan);

/**
 * @swagger
 * /badge/admin/plans/{id}:
 *   delete:
 *     summary: Admin delete plan
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Plan deleted
 */
router.delete('/admin/plans/:id', authenticate, requireAdmin, badge.adminDeletePlan);

/**
 * @swagger
 * /badge/admin/confirm/{badgeId}:
 *   post:
 *     summary: Admin confirm badge
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: badgeId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Badge confirmed
 */
router.post('/admin/confirm/:badgeId', authenticate, requireAdmin, badge.adminConfirmBadge);

/**
 * @swagger
 * /badge/admin/reject/{badgeId}:
 *   post:
 *     summary: Admin reject badge
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: badgeId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Badge rejected
 */
router.post('/admin/reject/:badgeId', authenticate, requireAdmin, badge.adminRejectBadge);

/**
 * @swagger
 * /badge/admin/{id}:
 *   delete:
 *     summary: Admin delete badge holder
 *     tags: [Badges]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Badge holder deleted
 */
router.delete('/admin/:id', authenticate, requireAdmin, badge.adminDeleteBadgeHolder);

export default router;
