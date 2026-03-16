import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../lib/prisma';
import config from '../config';
import { mainBot } from '../bots/main.bot';

// ─── Login Step 1: Check if username has an account ───────────────────────────
export const checkLoginUsername = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramUsername } = req.body;
    if (!telegramUsername) {
      res.status(400).json({ success: false, message: 'Username is required' });
      return;
    }

    const username = telegramUsername.replace('@', '').trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: { telegramUsername: { equals: username, mode: 'insensitive' } },
      select: { id: true, firstName: true },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        message: `No account found for @${username}. Please register first.`,
      });
      return;
    }

    res.json({ success: true, data: { firstName: user.firstName } });
  } catch (error) {
    console.error('[checkLoginUsername]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Step 1: Check Telegram username ──────────────────────────────────────────
// Frontend sends telegramUsername, backend validates by fetching chat info
export const checkUsername = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramUsername } = req.body;

    if (!telegramUsername) {
      res.status(400).json({ success: false, message: 'Telegram username is required' });
      return;
    }

    const username = telegramUsername.replace('@', '').trim();

    // Check if already registered
    const existing = await prisma.user.findUnique({
      where: { telegramUsername: username },
    });
    if (existing) {
      res.status(409).json({ success: false, message: 'An account with this Telegram username already exists' });
      return;
    }


    // Validate username format (Telegram: 5-32 chars, letters/digits/underscores)
    const usernameRegex = /^[a-zA-Z0-9_]{5,32}$/;
    if (!usernameRegex.test(username)) {
      res.status(400).json({
        success: false,
        message: 'Invalid username. Telegram usernames must be 5-32 characters (letters, numbers, underscores only).',
      });
      return;
    }

    // Note: deeper Telegram identity verification happens in Step 2 —
    // when the user clicks the bot link and sends /start, the bot
    // receives the command from their actual Telegram account.
    // A fake username simply cannot complete Step 2.

    // Create a registration token (expires in 10 minutes)
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.registrationToken.create({
      data: { token, telegramUsername: username, expiresAt },
    });

    // Build bot deep link using the real bot username
    let botUsername = 'BuddyStoreBot';
    try {
      const me = await mainBot.api.getMe();
      botUsername = me.username ?? botUsername;
    } catch { /* use fallback */ }
    const botStartLink = `https://t.me/${botUsername}?start=${token}`;

    res.json({
      success: true,
      message: 'Username verified! Please start our bot to continue.',
      data: { token, botStartLink },
    });
  } catch (error) {
    console.error('[checkUsername]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Step 2: Poll to check if bot was started ─────────────────────────────────
export const verifyBot = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.body;

    if (!token) {
      res.status(400).json({ success: false, message: 'Token is required' });
      return;
    }

    const regToken = await prisma.registrationToken.findUnique({ where: { token } });

    if (!regToken) {
      res.status(404).json({ success: false, message: 'Invalid token' });
      return;
    }

    if (new Date() > regToken.expiresAt) {
      res.status(410).json({ success: false, message: 'Token has expired, please start over' });
      return;
    }

    if (!regToken.verified) {
      res.json({ success: true, verified: false, message: 'Please start the bot first' });
      return;
    }

    // Bot has been started — return user's Telegram info
    res.json({
      success: true,
      verified: true,
      message: 'Bot verified! You can now set your password.',
      data: {
        token,
        telegramUsername: regToken.telegramUsername,
        firstName: regToken.firstName,
        lastName: regToken.lastName,
      },
    });
  } catch (error) {
    console.error('[verifyBot]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Step 3: Set password and finalize registration ───────────────────────────
export const setPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      res.status(400).json({ success: false, message: 'Token and password are required' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }

    const regToken = await prisma.registrationToken.findUnique({ where: { token } });

    if (!regToken || !regToken.verified || !regToken.telegramId) {
      res.status(400).json({ success: false, message: 'Invalid or incomplete registration token' });
      return;
    }

    if (new Date() > regToken.expiresAt) {
      res.status(410).json({ success: false, message: 'Token has expired, please start over' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        telegramId: regToken.telegramId,
        telegramUsername: regToken.telegramUsername,
        firstName: regToken.firstName || '',
        lastName: regToken.lastName || null,
        languageCode: regToken.languageCode || null,
        passwordHash,
      },
    });

    // Clean up token
    await prisma.registrationToken.delete({ where: { token } });

    // Issue JWT
    const jwtToken = jwt.sign(
      { id: user.id, role: user.role, telegramUsername: user.telegramUsername },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      data: {
        token: jwtToken,
        user: {
          id: user.id,
          telegramId: user.telegramId.toString(),
          telegramUsername: user.telegramUsername,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
      },
    });
  } catch (error) {
    console.error('[setPassword]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Login ────────────────────────────────────────────────────────────────────
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramUsername, password } = req.body;

    if (!telegramUsername || !password) {
      res.status(400).json({ success: false, message: 'Telegram username and password are required' });
      return;
    }

    const username = telegramUsername.replace('@', '').trim();

    const user = await prisma.user.findUnique({ where: { telegramUsername: username } });

    if (!user) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, telegramUsername: user.telegramUsername },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          id: user.id,
          telegramId: user.telegramId.toString(),
          telegramUsername: user.telegramUsername,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
      },
    });
  } catch (error) {
    console.error('[login]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Forgot Password Step 1: Send OTP via Telegram ────────────────────────────
export const requestPasswordReset = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramUsername } = req.body;
    if (!telegramUsername) {
      res.status(400).json({ success: false, message: 'Telegram username is required' });
      return;
    }

    const username = telegramUsername.replace('@', '').trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: { telegramUsername: { equals: username, mode: 'insensitive' } },
    });

    if (!user) {
      // Return generic message to prevent username enumeration
      res.json({
        success: true,
        message: 'If this account exists, an OTP has been sent to your Telegram.',
      });
      return;
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Delete any existing unused OTPs for this user
    await prisma.passwordResetOtp.deleteMany({
      where: { telegramUsername: username, used: false },
    });

    // Save new OTP
    await prisma.passwordResetOtp.create({
      data: { telegramUsername: username, otp, expiresAt },
    });

    // Send OTP via Telegram main bot
    try {
      await mainBot.api.sendMessage(
        Number(user.telegramId),
        `🔐 *BuddyStore Password Reset*\n\nYour one-time password (OTP) is:\n\n*${otp}*\n\nThis code expires in 5 minutes. Do not share it with anyone.\n\nIf you did not request this, please ignore this message.`,
        { parse_mode: 'Markdown' }
      );
    } catch (telegramError) {
      console.error('[requestPasswordReset] Telegram send failed:', telegramError);
      res.status(500).json({ success: false, message: 'Failed to send OTP. Make sure you have started our main bot first.' });
      return;
    }

    res.json({
      success: true,
      message: 'OTP sent to your Telegram account.',
    });
  } catch (error) {
    console.error('[requestPasswordReset]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Forgot Password Step 2: Verify OTP and Reset Password ────────────────────
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramUsername, otp, newPassword } = req.body;

    if (!telegramUsername || !otp || !newPassword) {
      res.status(400).json({ success: false, message: 'All fields are required' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }

    const username = telegramUsername.replace('@', '').trim().toLowerCase();

    const otpRecord = await prisma.passwordResetOtp.findFirst({
      where: { telegramUsername: username, otp, used: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      res.status(400).json({ success: false, message: 'Invalid OTP. Please check and try again.' });
      return;
    }

    if (new Date() > otpRecord.expiresAt) {
      res.status(410).json({ success: false, message: 'OTP has expired. Please request a new one.' });
      return;
    }

    // Find user
    const user = await prisma.user.findFirst({
      where: { telegramUsername: { equals: username, mode: 'insensitive' } },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'Account not found' });
      return;
    }

    // Hash new password and update
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // Mark OTP as used
    await prisma.passwordResetOtp.update({
      where: { id: otpRecord.id },
      data: { used: true },
    });

    res.json({ success: true, message: 'Password reset successfully! You can now log in.' });
  } catch (error) {
    console.error('[resetPassword]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
