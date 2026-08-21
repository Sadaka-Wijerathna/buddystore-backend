import { Router } from 'express';
import multer from 'multer';
import * as badge from '../controllers/badge.controller';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── User routes (authenticated) ───────────────────────────────────────────────
router.get('/plans', authenticate, badge.getBadgePlans);
router.get('/status', authenticate, badge.getBadgeStatus);
router.post('/purchase', authenticate, upload.single('receipt'), badge.purchaseBadge);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get('/admin/list', authenticate, requireAdmin, badge.adminListBadges);
router.get('/admin/plans', authenticate, requireAdmin, badge.adminGetPlans);
router.post('/admin/plans', authenticate, requireAdmin, badge.adminCreatePlan);
router.put('/admin/plans/:id', authenticate, requireAdmin, badge.adminUpdatePlan);
router.delete('/admin/plans/:id', authenticate, requireAdmin, badge.adminDeletePlan);
router.post('/admin/confirm/:badgeId', authenticate, requireAdmin, badge.adminConfirmBadge);
router.post('/admin/reject/:badgeId', authenticate, requireAdmin, badge.adminRejectBadge);
router.delete('/admin/:id', authenticate, requireAdmin, badge.adminDeleteBadgeHolder);

export default router;
