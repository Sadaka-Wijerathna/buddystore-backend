import { Router } from 'express';
import * as orderController from '../controllers/order.controller';
import { authenticate } from '../middleware/auth.middleware';
import upload from '../middleware/upload.middleware';

const router = Router();

// All order routes need authentication
router.use(authenticate);

// Token-based bot verification (register-page pattern)
router.post('/bot-verify-tokens', orderController.createBotVerifyTokens);
router.get('/bot-verify-tokens', orderController.pollBotVerifyTokens);

// Check which bots user has started (legacy, kept for compat)
router.get('/check-bots', orderController.checkUserBots);

// Create multiple orders at once with one receipt (used by checkout)
router.post('/batch', upload.single('receipt'), orderController.createBatchOrders);

// Create single order with receipt upload
router.post('/', upload.single('receipt'), orderController.createOrder);

// Get current user's orders
router.get('/', orderController.getMyOrders);

// Get specific order details with delivery progress
router.get('/:id', orderController.getOrderById);

export default router;
