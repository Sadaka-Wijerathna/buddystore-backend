import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';

const router = Router();

// All admin routes need authentication + admin role
router.use(authenticate, requireAdmin);

// Bots
router.get('/bots', adminController.getBots);
router.patch('/bots/:id/collection-mode', adminController.toggleCollectionMode);
router.patch('/bots/:id/settings', adminController.updateBotSettings);
router.patch('/bots/:id/min-video-count', adminController.updateBotMinVideoCount);
router.delete('/bots/:id/videos', adminController.clearBotVideos);

// Users
router.get('/users', adminController.getUsers);
router.put('/users/:id/role', adminController.updateUserRole);

// Orders
router.get('/orders', adminController.getAllOrders);
router.delete('/orders', adminController.deleteAllOrders);
router.patch('/orders/confirm-by-receipt', adminController.confirmOrdersByReceipt);
router.patch('/orders/:id/status', adminController.updateOrderStatus);
router.get('/orders/:id/progress', adminController.getOrderProgress);

// Analytics
router.get('/analytics', adminController.getAnalytics);

export default router;

