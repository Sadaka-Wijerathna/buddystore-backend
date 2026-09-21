import { Router } from 'express';
import { initiateOrder, createOrder, createBatchOrders, getMyOrders, getOrderById, createBotVerifyTokens, pollBotVerifyTokens, checkUserBots, getRecommendations, getCategoryLimits, getStarsStatus, fulfillStarsOrder } from '../controllers/order.controller';
import { getNotifications, subscribeToPush, unsubscribeFromPush } from '../controllers/notification.controller';

import { authenticate } from '../middleware/auth.middleware';
import upload from '../middleware/upload.middleware';

const router = Router();

// All order routes need authentication
router.use(authenticate);

/**
 * @swagger
 * tags:
 *   name: Orders
 *   description: Order management and delivery
 */

/**
 * @swagger
 * /orders/notifications:
 *   get:
 *     summary: Get notifications
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of notifications
 */
router.get('/notifications', getNotifications);

/**
 * @swagger
 * /orders/notifications/subscribe:
 *   post:
 *     summary: Subscribe to push notifications
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscribed
 */
router.post('/notifications/subscribe', subscribeToPush);

/**
 * @swagger
 * /orders/notifications/unsubscribe:
 *   delete:
 *     summary: Unsubscribe from push notifications
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unsubscribed
 */
router.delete('/notifications/unsubscribe', unsubscribeFromPush);

/**
 * @swagger
 * /orders/category-limits:
 *   get:
 *     summary: Get available, min, and max video limits for a category
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: category
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category limits
 */
router.get('/category-limits', getCategoryLimits);

/**
 * @swagger
 * /orders/initiate:
 *   post:
 *     summary: Initiate order (abandoned cart hook)
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order initiated
 */
router.post('/initiate', initiateOrder);

/**
 * @swagger
 * /orders/batch:
 *   post:
 *     summary: Create multiple orders at once
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Orders created
 */
router.post('/batch', upload.single('receipt'), createBatchOrders);

/**
 * @swagger
 * /orders:
 *   post:
 *     summary: Create single order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order created
 */
router.post('/', upload.single('receipt'), createOrder);

/**
 * @swagger
 * /orders:
 *   get:
 *     summary: Get current user's orders
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of orders
 */
router.get('/', getMyOrders);

/**
 * @swagger
 * /orders/recommendations:
 *   get:
 *     summary: Get smart recommendations
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Recommendations
 */
router.get('/recommendations', getRecommendations);

/**
 * @swagger
 * /orders/bot-verify-tokens:
 *   post:
 *     summary: Token-based bot verification
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token created
 */
router.post('/bot-verify-tokens', createBotVerifyTokens);

/**
 * @swagger
 * /orders/bot-verify-tokens:
 *   get:
 *     summary: Poll bot verify tokens
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token status
 */
router.get('/bot-verify-tokens', pollBotVerifyTokens);

/**
 * @swagger
 * /orders/check-bots:
 *   get:
 *     summary: Check which bots user has started
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bots started
 */
router.get('/check-bots', checkUserBots);

/**
 * @swagger
 * /orders/stars-status/{id}:
 *   get:
 *     summary: Stars Payment Polling
 *     tags: [Orders]
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
 *         description: Status
 */
router.get('/stars-status/:id', getStarsStatus);

/**
 * @swagger
 * /orders/stars-fulfill/{id}:
 *   post:
 *     summary: Stars Fulfillment
 *     tags: [Orders]
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
 *         description: Fulfilled
 */
router.post('/stars-fulfill/:id', fulfillStarsOrder);

/**
 * @swagger
 * /orders/{id}:
 *   get:
 *     summary: Get specific order details
 *     tags: [Orders]
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
 *         description: Order details
 */
router.get('/:id', getOrderById);

export default router;
