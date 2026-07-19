import { Router } from 'express';
import { initiateOrder, createOrder, createBatchOrders, getMyOrders, getOrderById, createBotVerifyTokens, pollBotVerifyTokens, checkUserBots, getRecommendations, getCategoryLimits, getStarsStatus, fulfillStarsOrder } from '../controllers/order.controller';
import { getNotifications, subscribeToPush, unsubscribeFromPush } from '../controllers/notification.controller';

import { authenticate } from '../middleware/auth.middleware';
import upload from '../middleware/upload.middleware';

const router = Router();

// All order routes need authentication
router.use(authenticate);

// Notifications derived from order history
router.get('/notifications', getNotifications);
router.post('/notifications/subscribe', subscribeToPush);
router.delete('/notifications/unsubscribe', unsubscribeFromPush);

// Get available, min, and max video limits for a category
router.get('/category-limits', getCategoryLimits);

// Initiate order (abandoned cart hook)
router.post('/initiate', initiateOrder);

// Create multiple orders at once with one receipt (used by checkout)
router.post('/batch', upload.single('receipt'), createBatchOrders);

// Create single order with receipt upload
router.post('/', upload.single('receipt'), createOrder);

// Get current user's orders
router.get('/', getMyOrders);

// Get smart recommendations based on order history
router.get('/recommendations', getRecommendations);

// Token-based bot verification (register-page pattern)
router.post('/bot-verify-tokens', createBotVerifyTokens);
router.get('/bot-verify-tokens', pollBotVerifyTokens);

// Check which bots user has started (legacy, kept for compat)
router.get('/check-bots', checkUserBots);

// Stars Payment Polling & Fulfillment
router.get('/stars-status/:id', getStarsStatus);
router.post('/stars-fulfill/:id', fulfillStarsOrder);

// Get specific order details with delivery progress
router.get('/:id', getOrderById);

export default router;
