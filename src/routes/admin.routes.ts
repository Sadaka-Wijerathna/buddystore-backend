import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import * as telegramController from '../controllers/telegram.controller';
import { authenticate, requireAdmin, requireSuperAdmin } from '../middleware/auth.middleware';
import upload from '../middleware/upload.middleware';

const router = Router();

// All admin routes need authentication + admin role
router.use(authenticate, requireAdmin);

// Bots
router.get('/bots', adminController.getBots);
router.post('/bots', requireSuperAdmin, adminController.createBot);
router.patch('/bots/:id/collection-mode', adminController.toggleCollectionMode);
router.patch('/bots/:id/settings', adminController.updateBotSettings);
router.patch('/bots/:id/min-video-count', adminController.updateBotMinVideoCount);
router.patch('/bots/:id/banner', upload.single('banner'), adminController.updateBotBanner);
router.delete('/bots/:id/videos', adminController.clearBotVideos);
router.delete('/bots/:id', requireSuperAdmin, adminController.deleteBot);


// Special Bot Collections
router.get('/special-collections', adminController.getSpecialCollections);
router.post('/special-collections', upload.single('banner'), adminController.createSpecialCollection);
router.patch('/special-collections/reorder', adminController.reorderSpecialCollections);
router.patch('/special-collections/:id', upload.single('banner'), adminController.updateSpecialCollection);
router.patch('/special-collections/:id/collection-mode', adminController.toggleSpecialCollectionMode);
router.delete('/special-collections/:id/videos', adminController.clearSpecialCollectionVideos);
router.delete('/special-collections/:id', adminController.deleteSpecialCollection);

// Users (read-only for all admins — write actions and data exports for SUPER_ADMIN only)
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

// Broadcasts
router.get('/broadcasts', adminController.getBroadcasts);
router.get('/broadcasts/:id/status', adminController.getBroadcastStatus);


// Orders
router.get('/orders', adminController.getAllOrders);
router.delete('/orders', requireSuperAdmin, adminController.deleteAllOrders);
router.delete('/orders/:id', requireSuperAdmin, adminController.deleteOrder);
router.patch('/orders/confirm-by-receipt', adminController.confirmOrdersByReceipt);
router.patch('/orders/:id/status', adminController.updateOrderStatus);
router.get('/orders/:id/progress', adminController.getOrderProgress);

// Analytics
router.get('/analytics', adminController.getAnalytics);

// Banned IPs
router.get('/banned-ips', adminController.getBannedIps);
router.post('/banned-ips', requireSuperAdmin, adminController.addBannedIp);
router.delete('/banned-ips/:ip', requireSuperAdmin, adminController.removeBannedIp);

// Settings
router.get('/settings', adminController.adminGetSettings);
router.put('/settings', requireSuperAdmin, adminController.adminUpdateSettings);

// Bank Accounts
router.get('/bank-accounts', adminController.adminGetBankAccounts);
router.post('/bank-accounts', requireSuperAdmin, upload.single('logo'), adminController.adminCreateBankAccount);
router.patch('/bank-accounts/reorder', requireSuperAdmin, adminController.adminReorderBankAccounts);
router.patch('/bank-accounts/:id', requireSuperAdmin, upload.single('logo'), adminController.adminUpdateBankAccount);
router.delete('/bank-accounts/:id', requireSuperAdmin, adminController.adminDeleteBankAccount);

// Affiliates
router.get('/affiliates', adminController.adminGetAffiliates);
router.post('/affiliates/clear', requireSuperAdmin, adminController.adminClearAffiliateData);

// Telegram Importer
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

