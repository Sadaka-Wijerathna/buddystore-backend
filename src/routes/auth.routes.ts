import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authLimiter, registerLimiter, otpLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

// Step 1: Check if telegram username is valid
router.post('/register/check-username', registerLimiter, authController.checkUsername);

// Step 2: Poll to check if user started the main bot
router.post('/register/verify-bot', registerLimiter, authController.verifyBot);

// Step 3: Set password and create account
router.post('/register/set-password', registerLimiter, authController.setPassword);

// Login Step 1: Check if username has an account
router.post('/login/check-username', authLimiter, authController.checkLoginUsername);

// Login
router.post('/login', authLimiter, authController.login);

// Forgot Password Step 1: Request OTP (sent via Telegram)
router.post('/forgot-password/request', otpLimiter, authController.requestPasswordReset);

// Forgot Password Step 2: Verify OTP is correct (does NOT consume it)
router.post('/forgot-password/verify-otp', otpLimiter, authController.verifyOtp);

// Forgot Password Step 3: Verify OTP + set new password (consumes the OTP)
router.post('/forgot-password/reset', otpLimiter, authController.resetPassword);

// Refresh JWT token (authenticated users — call before token expires)
router.post('/refresh-token', authenticate, authController.refreshToken);

// Change password (authenticated users)
router.post('/change-password', authenticate, authController.changePassword);
// Fetch user's wallet and referral summary
router.get('/me/wallet', authenticate, authController.getWallet);
// Fetch only user's wallet balance
router.get('/me/balance', authenticate, authController.getBalance);

// Fetch the user's Telegram profile photo URL
router.get('/me/photo', authenticate, authController.getPhoto);

export default router;

