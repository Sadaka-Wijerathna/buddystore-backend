import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// Step 1: Check if telegram username is valid
router.post('/register/check-username', authController.checkUsername);

// Step 2: Poll to check if user started the main bot
router.post('/register/verify-bot', authController.verifyBot);

// Step 3: Set password and create account
router.post('/register/set-password', authController.setPassword);

// Login Step 1: Check if username has an account
router.post('/login/check-username', authController.checkLoginUsername);

// Login
router.post('/login', authController.login);

// Forgot Password Step 1: Request OTP (sent via Telegram)
router.post('/forgot-password/request', authController.requestPasswordReset);

// Forgot Password Step 2: Verify OTP and set new password
router.post('/forgot-password/reset', authController.resetPassword);

// Refresh JWT token (authenticated users — call before token expires)
router.post('/refresh-token', authenticate, authController.refreshToken);

// Change password (authenticated users)
router.post('/change-password', authenticate, authController.changePassword);

export default router;

