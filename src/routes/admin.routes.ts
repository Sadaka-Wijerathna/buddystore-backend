import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import * as telegramController from '../controllers/telegram.controller';
import { authenticate, requireAdmin, requireSuperAdmin } from '../middleware/auth.middleware';
import upload from '../middleware/upload.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Administrator routes for store management
 */

// All admin routes need authentication + admin role
router.use(authenticate, requireAdmin);

// Bots
/**
 * @swagger
 * /admin/bots:
 *   get:
 *     summary: List all bots
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of bots
 */
router.get('/bots', adminController.getBots);
/**
 * @swagger
 * /admin/bots:
 *   post:
 *     summary: Create a new bot
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bot created
 */
router.post('/bots', requireSuperAdmin, adminController.createBot);
router.patch('/bots/:id/collection-mode', adminController.toggleCollectionMode);
router.patch('/bots/:id/badge-only', adminController.toggleBotBadgeOnly);
router.patch('/bots/:id/settings', adminController.updateBotSettings);
router.patch('/bots/:id/min-video-count', adminController.updateBotMinVideoCount);
router.patch('/bots/:id/banner', upload.single('banner'), adminController.updateBotBanner);
router.delete('/bots/:id/videos', adminController.clearBotVideos);
router.delete('/bots/:id', requireSuperAdmin, adminController.deleteBot);

// Special Bot Collections
/**
 * @swagger
 * /admin/special-collections:
 *   get:
 *     summary: List all special collections
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of special collections
 */
router.get('/special-collections', adminController.getSpecialCollections);
router.post('/special-collections', upload.single('banner'), adminController.createSpecialCollection);
router.patch('/special-collections/reorder', adminController.reorderSpecialCollections);
router.patch('/special-collections/:id', upload.single('banner'), adminController.updateSpecialCollection);
router.patch('/special-collections/:id/collection-mode', adminController.toggleSpecialCollectionMode);
router.patch('/special-collections/:id/badge-only', adminController.toggleSpecialCollectionBadgeOnly);
router.delete('/special-collections/:id/videos', adminController.clearSpecialCollectionVideos);
router.delete('/special-collections/:id', adminController.deleteSpecialCollection);

// Users
/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: List all users
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
 */
router.get('/users/export', requireSuperAdmin, adminController.exportUsersCSV); // Fix #12: restricted to SUPER_ADMIN
router.get('/users', adminController.getUsers);
router.put('/users/:id/role', requireSuperAdmin, adminController.updateUserRole);
router.patch('/users/:id/ban', requireSuperAdmin, adminController.banUser);
router.delete('/users/:id', requireSuperAdmin, adminController.deleteUser);
router.post('/users/broadcast', upload.single('media'), adminController.broadcastMessage);
router.get('/users/:id/orders', adminController.getUserOrders);
router.post('/users/:id/message', upload.single('media'), adminController.messageUser);
router.post('/users/:id/wallet-adjust', adminController.adminAdjustWallet);
router.post('/users/:id/ban-ip', requireSuperAdmin, adminController.banUserIp);
router.post('/users/:id/impersonate', requireSuperAdmin, adminController.impersonateUser);
router.post('/users/:id/place-order', adminController.adminPlaceOrder);
router.get('/users/:id/limits', adminController.getUserCategoryLimits);

// Broadcasts
/**
 * @swagger
 * /admin/broadcasts:
 *   get:
 *     summary: List all broadcasts
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of broadcasts
 */
router.get('/broadcasts', adminController.getBroadcasts);
router.get('/broadcasts/:id/status', adminController.getBroadcastStatus);

// Orders
/**
 * @swagger
 * /admin/orders:
 *   get:
 *     summary: List all orders
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of orders
 */
router.get('/orders', adminController.getAllOrders);
router.delete('/orders', requireSuperAdmin, adminController.deleteAllOrders);
router.delete('/orders/:id', requireSuperAdmin, adminController.deleteOrder);
router.patch('/orders/confirm-by-receipt', adminController.confirmOrdersByReceipt);
router.patch('/orders/:id/status', adminController.updateOrderStatus);
router.get('/orders/:id/progress', adminController.getOrderProgress);

// Analytics
/**
 * @swagger
 * /admin/analytics:
 *   get:
 *     summary: Get analytics dashboard data
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Analytics data
 */
router.get('/analytics', adminController.getAnalytics);

// Banned IPs
/**
 * @swagger
 * /admin/banned-ips:
 *   get:
 *     summary: List all banned IPs
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of banned IPs
 */
router.get('/banned-ips', adminController.getBannedIps);
router.post('/banned-ips', requireSuperAdmin, adminController.addBannedIp);
router.delete('/banned-ips/:ip', requireSuperAdmin, adminController.removeBannedIp);

// Settings
/**
 * @swagger
 * /admin/settings:
 *   get:
 *     summary: Get admin settings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Settings data
 */
router.get('/settings', adminController.adminGetSettings);
router.put('/settings', requireSuperAdmin, adminController.adminUpdateSettings);

// Bank Accounts
/**
 * @swagger
 * /admin/bank-accounts:
 *   get:
 *     summary: List bank accounts for admin
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bank accounts
 */
router.get('/bank-accounts', adminController.adminGetBankAccounts);
router.post('/bank-accounts', requireSuperAdmin, upload.single('logo'), adminController.adminCreateBankAccount);
router.patch('/bank-accounts/reorder', requireSuperAdmin, adminController.adminReorderBankAccounts);
router.patch('/bank-accounts/:id', requireSuperAdmin, upload.single('logo'), adminController.adminUpdateBankAccount);
router.delete('/bank-accounts/:id', requireSuperAdmin, adminController.adminDeleteBankAccount);

// Affiliates
/**
 * @swagger
 * /admin/affiliates:
 *   get:
 *     summary: List affiliates
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Affiliates list
 */
router.get('/affiliates', adminController.adminGetAffiliates);
router.post('/affiliates/clear', requireSuperAdmin, adminController.adminClearAffiliateData);

// Telegram Importer
/**
 * @swagger
 * /admin/telegram/status:
 *   get:
 *     summary: Get MTProto status
 *     tags: [Admin Telegram]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Status info
 */
router.get('/telegram/status', telegramController.statusController);
router.get('/telegram/chats', telegramController.listChatsController);
router.get('/telegram/count-videos', telegramController.countVideosController);
router.get('/telegram/checkpoint', telegramController.checkpointController);
router.get('/telegram/jobs', telegramController.listJobsController);
router.post('/telegram/send-code', telegramController.sendCodeController);
router.post('/telegram/login', telegramController.loginController);
router.post('/telegram/start-import', telegramController.startImportController);
router.post('/telegram/resume-import', telegramController.resumeImportController);
router.post('/telegram/stop-import', telegramController.stopImportController);
router.get('/telegram/accounts', telegramController.accountsController);
router.post('/telegram/switch-account', telegramController.switchAccountController);
router.post('/telegram/logout-account', telegramController.logoutAccountController);
router.post('/telegram/logout', telegramController.logoutController);
router.post('/telegram/reset-checkpoints', telegramController.resetCheckpointsController);
router.delete('/telegram/jobs', telegramController.clearAllJobsController);
router.delete('/telegram/jobs/:id', telegramController.deleteJobController);

export default router;

