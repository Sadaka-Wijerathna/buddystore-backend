import { Router } from 'express';
import * as authController from '../controllers/auth.controller';

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

export default router;
