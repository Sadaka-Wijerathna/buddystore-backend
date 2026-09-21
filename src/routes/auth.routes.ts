import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authLimiter, registerLimiter, otpLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication and user management
 */

/**
 * @swagger
 * /auth/register/check-username:
 *   post:
 *     summary: Check if a Telegram username is valid and available
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *     responses:
 *       200:
 *         description: Username is valid
 */
router.post('/register/check-username', registerLimiter, authController.checkUsername);

/**
 * @swagger
 * /auth/register/verify-bot:
 *   post:
 *     summary: Poll to check if user started the main bot
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *     responses:
 *       200:
 *         description: Bot verified
 */
router.post('/register/verify-bot', registerLimiter, authController.verifyBot);

/**
 * @swagger
 * /auth/register/set-password:
 *   post:
 *     summary: Set password and create account
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account created successfully
 */
router.post('/register/set-password', registerLimiter, authController.setPassword);

/**
 * @swagger
 * /auth/login/check-username:
 *   post:
 *     summary: Check if username has an account
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account exists
 */
router.post('/login/check-username', authLimiter, authController.checkLoginUsername);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Log in with username and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Successfully logged in
 */
router.post('/login', authLimiter, authController.login);

/**
 * @swagger
 * /auth/telegram-widget:
 *   post:
 *     summary: Telegram Login Widget verification
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Successfully logged in via widget
 */
router.post('/telegram-widget', authLimiter, authController.telegramWidgetLogin);

/**
 * @swagger
 * /auth/telegram-oidc:
 *   post:
 *     summary: Telegram OIDC callback
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Successfully logged in via OIDC
 */
router.post('/telegram-oidc', authLimiter, authController.telegramOidcCallback);

/**
 * @swagger
 * /auth/forgot-password/request:
 *   post:
 *     summary: Request OTP (sent via Telegram)
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: OTP requested
 */
router.post('/forgot-password/request', otpLimiter, authController.requestPasswordReset);

/**
 * @swagger
 * /auth/forgot-password/verify-otp:
 *   post:
 *     summary: Verify OTP is correct
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: OTP is valid
 */
router.post('/forgot-password/verify-otp', otpLimiter, authController.verifyOtp);

/**
 * @swagger
 * /auth/forgot-password/reset:
 *   post:
 *     summary: Verify OTP + set new password
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Password reset successfully
 */
router.post('/forgot-password/reset', otpLimiter, authController.resetPassword);

/**
 * @swagger
 * /auth/refresh-token:
 *   post:
 *     summary: Refresh JWT token
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token refreshed
 */
router.post('/refresh-token', authenticate, authController.refreshToken);

/**
 * @swagger
 * /auth/change-password:
 *   post:
 *     summary: Change password
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Password changed
 */
router.post('/change-password', authenticate, authController.changePassword);

/**
 * @swagger
 * /auth/me/wallet:
 *   get:
 *     summary: Fetch user's wallet and referral summary
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wallet summary
 */
router.get('/me/wallet', authenticate, authController.getWallet);

/**
 * @swagger
 * /auth/me/balance:
 *   get:
 *     summary: Fetch only user's wallet balance
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wallet balance
 */
router.get('/me/balance', authenticate, authController.getBalance);

/**
 * @swagger
 * /auth/me/bot-status:
 *   get:
 *     summary: Lightweight poll to check bot status
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bot status
 */
router.get('/me/bot-status', authenticate, authController.getBotStatus);

/**
 * @swagger
 * /auth/me/photo:
 *   get:
 *     summary: Fetch the user's Telegram profile photo URL
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile photo URL
 */
router.get('/me/photo', authenticate, authController.getPhoto);

/**
 * @swagger
 * /auth/me:
 *   delete:
 *     summary: Delete the authenticated user's own account
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Account deleted
 */
router.delete('/me', authenticate, authController.deleteAccount);

export default router;

