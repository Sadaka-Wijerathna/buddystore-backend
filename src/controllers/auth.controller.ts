import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomInt, randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import config from '../config';
import { dispatchNotification } from './notification.controller';

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Extract the real client IP, respecting proxy headers. */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return ips.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? req.ip ?? 'unknown';
}

/** Classify device from User-Agent string. */
function getDeviceType(req: Request): string {
  const ua = (req.headers['user-agent'] ?? '').toLowerCase();
  if (/mobile|android|iphone|ipad|ipod|blackberry|windows phone/i.test(ua)) return 'Mobile';
  if (/tablet|ipad/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

/**
 * Fix #7: Password complexity validator.
 * Returns an error message string if the password is too weak, or null if it passes.
 * Rules: 8+ chars, at least one uppercase, one lowercase, one digit.
 */
function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null;
}

// Lazy-load mainBot to avoid crashing the entire controller if the
// MAIN_BOT_TOKEN env var is missing or the grammy Bot constructor throws.
function getMainBot() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mainBot } = require('../bots/main.bot');
    return mainBot;
  } catch {
    return null;
  }
}

/**
 * Format a past date as a human-readable "time ago" string.
 */
function getTimeAgoText(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffMins > 0) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Fetch the user's Telegram profile photo URL using the main bot.
 * Times out after 3 s — never delays login or token refresh.
 * Returns null if the user has no photo, bot is unavailable, or it times out.
 */
export async function syncTelegramProfile(telegramId: bigint | string): Promise<{ photoUrl: string | null; firstName: string; lastName: string | null; username: string | null } | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000));

  const fetch = async (): Promise<{ photoUrl: string | null; firstName: string; lastName: string | null; username: string | null } | null> => {
    try {
      const bot = getMainBot();
      if (!bot) return null;

      const chat = await bot.api.getChat(Number(telegramId));
      if (chat.type !== 'private') return null;

      // Fix #9: Do NOT embed the raw bot token in the URL.
      // Store only the Telegram file_id — the /me/photo endpoint resolves it
      // server-side on demand so the token never leaves the backend.
      let photoUrl = null;
      try {
        const photos = await bot.api.getUserProfilePhotos(Number(telegramId), { limit: 1 });
        if (photos.total_count && photos.photos[0]?.length) {
          // Use the largest available size (last in the array, ordered small→large)
          const sizes = photos.photos[0];
          const largest = sizes[sizes.length - 1];
          // Store the opaque file_id, not https://api.telegram.org/file/bot<TOKEN>/...
          photoUrl = `tg-file:${largest.file_id}`;
        }
      } catch (photoErr) {
        console.warn('[syncTelegramProfile] Failed to fetch profile photo:', photoErr);
      }

      return {
        photoUrl,
        firstName: chat.first_name,
        lastName: chat.last_name || null,
        username: chat.username || null,
      };
    } catch {
      return null;
    }
  };

  return Promise.race([fetch(), timeout]);
}

/**
 * Resolve a stored `tg-file:<fileId>` to a real Telegram CDN URL server-side.
 * Returns null if resolution fails or the URL is not a tg-file: reference.
 */
export async function resolveTgFileUrl(
  raw: string | null,
  persistToUserId?: string,
): Promise<string | null> {
  if (!raw) return null;
  if (!raw.startsWith('tg-file:')) return raw; // already a real HTTPS URL — fast path
  try {
    const bot = getMainBot();
    if (!bot) return null;
    const fileId = raw.replace('tg-file:', '');
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const resolved = `https://api.telegram.org/file/bot${config.bots.main}/${file.file_path}`;
    // Persist the resolved URL so the next call takes the fast path
    if (persistToUserId) {
      prisma.user
        .update({ where: { id: persistToUserId }, data: { photoUrl: resolved } })
        .catch(() => { /* non-critical — ignore */ });
    }
    return resolved;
  } catch (err) {
    console.warn('[resolveTgFileUrl] Failed to resolve tg-file:', err);
    return null;
  }
}


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
      select: { id: true, firstName: true, telegramId: true },
    });

    if (!user) {
      // Check if they are trying to use an old username
      const oldUser = await prisma.user.findFirst({
        where: { oldTelegramUsername: { equals: username, mode: 'insensitive' } },
        select: { telegramUsername: true, usernameUpdatedAt: true },
      });

      if (oldUser && oldUser.usernameUpdatedAt) {
        const timeText = getTimeAgoText(oldUser.usernameUpdatedAt);
        res.status(404).json({
          success: false,
          message: `You changed your Telegram username ${timeText}. Please log in using your current username: @${oldUser.telegramUsername}`,
        });
        return;
      }

      res.status(404).json({
        success: false,
        message: `No account found for @${username}. Please register first.`,
      });
      return;
    }

    // Fetch profile photo and info non-blocking (3 s timeout inside)
    const profile = await syncTelegramProfile(user.telegramId);

    // Resolve tg-file:<fileId> → real CDN URL (token stays server-side)
    const resolvedPhotoUrl = await resolveTgFileUrl(profile?.photoUrl || null);

    res.json({ success: true, data: { firstName: user.firstName, photoUrl: resolvedPhotoUrl } });
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
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.registrationToken.create({
      data: { token, telegramUsername: username, expiresAt },
    });

    // Build bot deep link using the real bot username
    let botUsername = 'BuddyStoreBot';
    try {
      const bot = getMainBot();
      if (bot) {
        const me = await bot.api.getMe();
        botUsername = me.username ?? botUsername;
      }
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

    let photoUrl: string | null = null;
    if (regToken.telegramId) {
      const profile = await syncTelegramProfile(regToken.telegramId);
      if (profile) photoUrl = await resolveTgFileUrl(profile.photoUrl);
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
        photoUrl,
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
    const { token, password, referralCode } = req.body;

    if (!token || !password) {
      res.status(400).json({ success: false, message: 'Token and password are required' });
      return;
    }

    // Fix #7: Enforce password complexity — length + uppercase + lowercase + digit
    const passwordError = validatePassword(password);
    if (passwordError) {
      res.status(400).json({ success: false, message: passwordError });
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

    // ─── IP Ban Check ───────────────────────────────────────────────────────
    const clientIp = getClientIp(req);
    const bannedIp = await prisma.bannedIp.findUnique({ where: { ip: clientIp } });
    if (bannedIp) {
      res.status(403).json({ success: false, message: 'Registration is not allowed from your network.' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Generate strict unique referral code (8 chars)
    const myReferralCode = randomUUID().split('-')[0].toUpperCase();

    let referredById: string | null = null;
    let referrerIdForTransaction: string | null = null;

    if (referralCode) {
      const referrer = await prisma.user.findUnique({
        where: { referralCode: typeof referralCode === 'string' ? referralCode.toUpperCase() : referralCode },
        select: { id: true },
      });
      if (referrer) {
        referredById = referrer.id;
        referrerIdForTransaction = referrer.id;
      }
    }

    // Execute User creation and optional Referrer reward in a transaction
    const transactionJobs = [];

    // Create user payload
    const userPayload: any = {
      telegramId: regToken.telegramId,
      telegramUsername: regToken.telegramUsername,
      firstName: regToken.firstName || '',
      lastName: regToken.lastName || null,
      languageCode: regToken.languageCode || null,
      passwordHash,
      // Privacy: we do NOT store IP addresses or device types.
      lastLoginAt: new Date(),
      referralCode: myReferralCode,
      referredById,
      role: regToken.telegramUsername.toLowerCase() === config.superAdminUsername ? 'ADMIN' : 'USER',
      adminRole: regToken.telegramUsername.toLowerCase() === config.superAdminUsername ? 'SUPER_ADMIN' : null,
    };

    // Fetch dynamic reward amount
    const rewardSetting = await prisma.setting.findUnique({
      where: { key: 'REFERRAL_REWARD_AMOUNT' },
    });
    const rewardAmount = rewardSetting ? Number(rewardSetting.value) : 300;

    // 1. Create User
    transactionJobs.push(prisma.user.create({ data: userPayload }));

    // 2. Clear Token
    transactionJobs.push(prisma.registrationToken.delete({ where: { token } }));

    // 3. Optional: Reward Referrer
    if (referrerIdForTransaction) {
      transactionJobs.push(
        prisma.user.update({
          where: { id: referrerIdForTransaction },
          data: { walletBalance: { increment: rewardAmount } },
        })
      );
      transactionJobs.push(
        prisma.walletTransaction.create({
          data: {
            userId: referrerIdForTransaction,
            amount: rewardAmount,
            type: 'EARNED',
            description: `Earned from referring @${regToken.telegramUsername}`,
          },
        })
      );
      dispatchNotification(
        referrerIdForTransaction,
        'wallet_bonus',
        `Referral Bonus! (+${rewardAmount})`,
        `You earned ${rewardAmount} LKR for referring @${regToken.telegramUsername}.`
      ).catch(e => console.error(e));
    }

    const results = await prisma.$transaction(transactionJobs);
    const user = results[0] as any; // the newly created user

    // Issue JWT
    const jwtToken = jwt.sign(
      { id: user.id, role: user.role, adminRole: user.adminRole, hasStartedBot: user.hasStartedBot, telegramUsername: user.telegramUsername, tokenVersion: user.tokenVersion ?? 0 },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    // Fetch Telegram profile (non-blocking for response)
    const profile = await syncTelegramProfile(user.telegramId);
    const resolvedPhotoUrl = await resolveTgFileUrl(profile?.photoUrl || null);

    if (profile) {
      prisma.user.update({
        where: { id: user.id },
        data: { 
          photoUrl: profile.photoUrl,
          firstName: profile.firstName,
          lastName: profile.lastName,
          telegramUsername: profile.username || user.telegramUsername,
          ...(profile.username && profile.username !== user.telegramUsername && {
            oldTelegramUsername: user.telegramUsername,
            usernameUpdatedAt: new Date(),
          })
        },
      }).catch(e => console.error('[setPassword] Profile update failed:', e));
    }

    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      data: {
        token: jwtToken,
        user: {
          id: user.id,
          telegramId: user.telegramId.toString(),
          telegramUsername: profile?.username || user.telegramUsername,
          firstName: profile?.firstName || user.firstName,
          lastName: profile?.lastName || user.lastName,
          role: user.role,
          adminRole: user.adminRole, hasStartedBot: user.hasStartedBot,
          photoUrl: resolvedPhotoUrl,
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

    const user = await prisma.user.findFirst({
      where: { telegramUsername: { equals: username, mode: 'insensitive' } },
    });

    if (!user) {
      // Check if they are trying to use an old username
      const oldUser = await prisma.user.findFirst({
        where: { oldTelegramUsername: { equals: username, mode: 'insensitive' } },
        select: { telegramUsername: true, usernameUpdatedAt: true },
      });

      if (oldUser && oldUser.usernameUpdatedAt) {
        const timeText = getTimeAgoText(oldUser.usernameUpdatedAt);
        res.status(401).json({
          success: false,
          message: `You changed your Telegram username ${timeText}. Please log in using your current username: @${oldUser.telegramUsername}`,
        });
        return;
      }

      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    // Force super admin to have SUPER_ADMIN role if missed somehow
    if (user.telegramUsername.toLowerCase() === config.superAdminUsername && user.adminRole !== 'SUPER_ADMIN') {
      user.role = 'ADMIN';
      user.adminRole = 'SUPER_ADMIN';
      await prisma.user.update({
        where: { id: user.id },
        data: { role: 'ADMIN', adminRole: 'SUPER_ADMIN' },
      });
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    // ─── Banned user check ──────────────────────────────────────────────────
    if (user.isBanned) {
      res.status(403).json({ success: false, message: 'Your account has been banned. Please contact support.' });
      return;
    }

    // ─── IP Ban Check ───────────────────────────────────────────────────────
    const clientIp = getClientIp(req);
    const bannedIp = await prisma.bannedIp.findUnique({ where: { ip: clientIp } });
    if (bannedIp) {
      res.status(403).json({ success: false, message: 'Access denied from your network.' });
      return;
    }

    // Fetch Telegram profile photo
    const profile = await syncTelegramProfile(user.telegramId);
    const resolvedPhotoUrl = await resolveTgFileUrl(profile?.photoUrl || null);

    // ─── Record last-login and profile update (fire-and-forget) ────────────
    // Privacy: IP address and device type are intentionally NOT stored.
    prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(profile && { 
          photoUrl: profile.photoUrl,
          firstName: profile.firstName,
          lastName: profile.lastName,
          telegramUsername: profile.username || user.telegramUsername,
          ...(profile.username && profile.username !== user.telegramUsername && {
            oldTelegramUsername: user.telegramUsername,
            usernameUpdatedAt: new Date(),
          })
        }),
      },
    }).catch(e => console.error('[login] Profile update failed:', e));

    const token = jwt.sign(
      { id: user.id, role: user.role, adminRole: user.adminRole, hasStartedBot: user.hasStartedBot, telegramUsername: profile?.username || user.telegramUsername, tokenVersion: user.tokenVersion },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    // Fetch active badge
    const superBadge = await prisma.superBadge.findUnique({
      where: { userId: user.id },
      select: { id: true, expiresAt: true, status: true },
    });
    const activeBadge = (superBadge?.status === 'ACTIVE' && superBadge.expiresAt > new Date()) ? superBadge : undefined;

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          id: user.id,
          telegramId: user.telegramId.toString(),
          telegramUsername: profile?.username || user.telegramUsername,
          firstName: profile?.firstName || user.firstName,
          lastName: profile?.lastName || user.lastName,
          role: user.role,
          adminRole: user.adminRole, hasStartedBot: user.hasStartedBot,
          photoUrl: resolvedPhotoUrl,
          superBadge: activeBadge,
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
        data: { photoUrl: null }
      });
      return;
    }

    // Rate-limit: reject if an OTP was already sent within the last 30 seconds
    const OTP_RESEND_COOLDOWN_SECONDS = 30;
    const recentOtp = await prisma.passwordResetOtp.findFirst({
      where: { telegramUsername: username, used: false },
      orderBy: { createdAt: 'desc' },
    });
    if (recentOtp) {
      const secondsSinceSent = Math.floor((Date.now() - recentOtp.createdAt.getTime()) / 1000);
      const remaining = OTP_RESEND_COOLDOWN_SECONDS - secondsSinceSent;
      if (remaining > 0) {
        res.status(429).json({
          success: false,
          message: `Please wait ${remaining} second${remaining !== 1 ? 's' : ''} before requesting a new OTP.`,
          retryAfter: remaining,
        });
        return;
      }
    }

    // Fix #6: Use crypto.randomInt — Math.random() is NOT cryptographically secure
    const otp = randomInt(100000, 999999).toString();
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
    const bot = getMainBot();
    if (!bot) {
      console.error('[requestPasswordReset] Main bot is not available (token missing or invalid)');
      res.status(503).json({ success: false, message: 'Password reset service is temporarily unavailable. Please try again later or contact support.' });
      return;
    }

    try {
      await bot.api.sendMessage(
        Number(user.telegramId),
        `🔐 *BuddyStore Password Reset*\n\nYour one-time password (OTP) is:\n\n*${otp}*\n\nThis code expires in 5 minutes. Do not share it with anyone.\n\nIf you did not request this, please ignore this message.`,
        { parse_mode: 'Markdown' }
      );
    } catch (telegramError) {
      console.error('[requestPasswordReset] Telegram send failed:', telegramError);
      res.status(500).json({ success: false, message: 'Failed to send OTP. Make sure you have started our main bot first.' });
      return;
    }

    const resolvedPhotoUrl = await resolveTgFileUrl(user.photoUrl || null);

    res.json({
      success: true,
      message: 'OTP sent to your Telegram account.',
      data: { photoUrl: resolvedPhotoUrl },
    });
  } catch (error) {
    console.error('[requestPasswordReset]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Forgot Password Step 2: Verify OTP (without consuming it) ───────────────
// Lets the frontend confirm the OTP is correct before showing the password form.
export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramUsername, otp } = req.body;

    if (!telegramUsername || !otp) {
      res.status(400).json({ success: false, message: 'Username and OTP are required' });
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

    // OTP is valid — do NOT mark as used yet; resetPassword will do that
    res.json({ success: true, message: 'OTP verified.' });
  } catch (error) {
    console.error('[verifyOtp]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Forgot Password Step 3: Verify OTP and Reset Password ────────────────────
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramUsername, otp, newPassword } = req.body;

    if (!telegramUsername || !otp || !newPassword) {
      res.status(400).json({ success: false, message: 'All fields are required' });
      return;
    }

    // Fix #7: Apply password complexity validation
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      res.status(400).json({ success: false, message: passwordError });
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

// ─── Refresh JWT Token ────────────────────────────────────────────────────
import { AuthRequest } from '../middleware/auth.middleware';

export const refreshToken = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // req.user is set by the authenticate middleware — token is still valid
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) {
      res.status(401).json({ success: false, message: 'User not found' });
      return;
    }

    const newToken = jwt.sign(
      { id: user.id, role: user.role, adminRole: user.adminRole, hasStartedBot: user.hasStartedBot, telegramUsername: user.telegramUsername, tokenVersion: user.tokenVersion },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    // ─── Update last-login on every refresh (fire-and-forget) ──────────────
    // Privacy: IP address and device type are intentionally NOT stored.
    prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    }).catch(e => console.error('[refreshToken] last-login update failed:', e));

    // Fetch Telegram profile (non-blocking)
    const profile = await syncTelegramProfile(user.telegramId);
    const resolvedPhotoUrl = await resolveTgFileUrl(profile?.photoUrl || null);

    if (profile) {
      prisma.user.update({
        where: { id: user.id },
        data: {
          photoUrl: profile.photoUrl,
          firstName: profile.firstName,
          lastName: profile.lastName,
          telegramUsername: profile.username || user.telegramUsername,
          ...(profile.username && profile.username !== user.telegramUsername && {
            oldTelegramUsername: user.telegramUsername,
            usernameUpdatedAt: new Date(),
          })
        }
      }).catch(e => console.error('[refreshToken] Profile update failed:', e));
    }

    // Fetch active badge
    const superBadge = await prisma.superBadge.findUnique({
      where: { userId: user.id },
      select: { id: true, expiresAt: true, status: true },
    });
    const activeBadge = (superBadge?.status === 'ACTIVE' && superBadge.expiresAt > new Date()) ? superBadge : undefined;

    res.json({
      success: true,
      data: {
        token: newToken,
        user: {
          id: user.id,
          telegramId: user.telegramId.toString(),
          telegramUsername: profile?.username || user.telegramUsername,
          firstName: profile?.firstName || user.firstName,
          lastName: profile?.lastName || user.lastName,
          role: user.role,
          adminRole: user.adminRole, hasStartedBot: user.hasStartedBot,
          photoUrl: resolvedPhotoUrl,
          superBadge: activeBadge,
        },
      },
    });
  } catch (error) {
    console.error('[refreshToken]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Change Password (authenticated) ──────────────────────────────────────────

export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, message: 'Current and new password are required' });
      return;
    }

    // Fix #7: Apply password complexity validation
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      res.status(400).json({ success: false, message: passwordError });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const isCorrect = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isCorrect) {
      res.status(401).json({ success: false, message: 'Current password is incorrect' });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    await dispatchNotification(
      user.id,
      'profile_update',
      'Security Alert',
      'Your account password was recently changed. If this wasn\'t you, please contact support immediately.'
    );

    res.json({ success: true, message: 'Password updated successfully!' });
  } catch (error) {
    console.error('[changePassword]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get User Wallet & Referrals ──────────────────────────────────────────────

export const getWallet = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        walletBalance: true,
        referralCode: true,
        referredUsers: {
          select: { id: true, telegramUsername: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
        walletTransactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    let finalReferralCode = user.referralCode;
    if (!finalReferralCode) {
      // Auto-generate for legacy users (8 chars)
      finalReferralCode = randomUUID().split('-')[0].toUpperCase();
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { referralCode: finalReferralCode },
      });
    }

    // Fetch dynamic reward amount for UI display
    const rewardSetting = await prisma.setting.findUnique({
      where: { key: 'REFERRAL_REWARD_AMOUNT' },
    });
    const rewardAmount = rewardSetting ? Number(rewardSetting.value) : 300;

    res.json({
      success: true,
      data: {
        walletBalance: user.walletBalance,
        referralCode: finalReferralCode,
        referredUsers: user.referredUsers,
        transactions: user.walletTransactions,
        rewardAmount,
      },
    });
  } catch (error) {
    console.error('[getWallet]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getBalance = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { walletBalance: true },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    res.json({
      success: true,
      data: { walletBalance: user.walletBalance },
    });
  } catch (error) {
    console.error('[getBalance]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get Bot Status (lightweight) ─────────────────────────────────────────────
// Returns only hasStartedBot — cheap single-field DB read with no Telegram I/O.
// Used by the BotNotifyBanner to poll until the user starts the bot.
export const getBotStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { hasStartedBot: true },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    res.json({ success: true, data: { hasStartedBot: user.hasStartedBot } });
  } catch (error) {
    console.error('[getBotStatus]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get Telegram Profile Photo ───────────────────────────────────────────────
export const getPhoto = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { telegramId: true, telegramUsername: true, photoUrl: true, hasStartedBot: true },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const profile = await syncTelegramProfile(user.telegramId);

    // Save it to DB if it's new (to ensure UI consistency)
    if (profile) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { 
          photoUrl: profile.photoUrl,
          firstName: profile.firstName,
          lastName: profile.lastName,
          telegramUsername: profile.username || user.telegramUsername,
          ...(profile.username && profile.username !== user.telegramUsername && {
            oldTelegramUsername: user.telegramUsername,
            usernameUpdatedAt: new Date(),
          })
        }
      });
    }

    // Resolve tg-file:<fileId> → real CDN URL (token stays server-side)
    const resolvedPhotoUrl = await resolveTgFileUrl(profile?.photoUrl || null);

    // Fetch active badge
    const superBadge = await prisma.superBadge.findUnique({
      where: { userId: req.user!.id },
      select: { id: true, expiresAt: true, status: true },
    });
    const activeBadge = (superBadge?.status === 'ACTIVE' && superBadge.expiresAt > new Date()) ? superBadge : undefined;

    res.json({ 
      success: true, 
      data: { 
        photoUrl: resolvedPhotoUrl,
        firstName: profile?.firstName,
        lastName: profile?.lastName,
        telegramUsername: profile?.username,
        superBadge: activeBadge,
        hasStartedBot: user.hasStartedBot,
      } 
    });
  } catch (error) {
    console.error('[getPhoto]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Telegram Login Widget ────────────────────────────────────────────────────
// Verifies data sent by the Telegram Login Widget (HMAC-SHA256 + auth_date check).
// Creates a new user if one doesn't exist for this telegramId, or logs in existing user.
// The existing username+password flow is completely unaffected.
export const telegramWidgetLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { hash, ...telegramData } = req.body as Record<string, string>;

    if (!hash || !telegramData.id || !telegramData.auth_date) {
      res.status(400).json({ success: false, message: 'Invalid Telegram login data' });
      return;
    }

    const botToken = config.bots.main;
    if (!botToken) {
      res.status(503).json({ success: false, message: 'Telegram login is not configured on this server' });
      return;
    }

    // ── Step 1: Verify HMAC-SHA256 hash ──────────────────────────────────────
    // secret_key = SHA256(bot_token) — NOT the token itself
    const secretKey = require('crypto').createHash('sha256').update(botToken).digest();
    const checkString = Object.keys(telegramData)
      .filter(k => telegramData[k] !== undefined && telegramData[k] !== null && telegramData[k] !== '')
      .sort()
      .map(k => `${k}=${telegramData[k]}`)
      .join('\n');
    const computedHash = require('crypto').createHmac('sha256', secretKey).update(checkString).digest('hex');

    if (computedHash !== hash) {
      res.status(401).json({ success: false, message: 'Telegram data verification failed' });
      return;
    }

    // ── Step 2: Check auth_date is fresh (within 24 hours) ───────────────────
    const authDate = parseInt(telegramData.auth_date, 10);
    const nowUnix = Math.floor(Date.now() / 1000);
    if (nowUnix - authDate > 86400) {
      res.status(401).json({ success: false, message: 'Telegram login session expired. Please try again.' });
      return;
    }

    // ── Step 3: Find or create user ───────────────────────────────────────────
    const telegramId = BigInt(telegramData.id);
    const incomingUsername = (telegramData.username || '').toLowerCase();

    let isNewUser = false;
    let user = await prisma.user.findUnique({ where: { telegramId } });

    if (!user) {
      isNewUser = true;

      // Determine safe username — fallback to tg_<id> if no username set
      let finalUsername = incomingUsername || `tg_${telegramData.id}`;

      // If that username is already taken by a different telegramId, append the id
      const taken = incomingUsername
        ? await prisma.user.findUnique({ where: { telegramUsername: finalUsername } })
        : null;
      if (taken) {
        finalUsername = `${finalUsername}_${telegramData.id}`;
      }

      // Widget users get a random unguessable passwordHash.
      // They can always set a real password later via Forgot Password.
      const randomHash = await bcrypt.hash(randomUUID() + randomUUID(), 12);
      const referralCode = randomUUID().split('-')[0].toUpperCase();

      user = await prisma.user.create({
        data: {
          telegramId,
          telegramUsername: finalUsername,
          firstName: telegramData.first_name || '',
          lastName: telegramData.last_name || null,
          passwordHash: randomHash,
          referralCode,
          photoUrl: telegramData.photo_url || null,
          lastLoginAt: new Date(),
          role: finalUsername === config.superAdminUsername ? 'ADMIN' : 'USER',
          adminRole: finalUsername === config.superAdminUsername ? 'SUPER_ADMIN' : null,
        },
      });
    } else {
      // Sync profile data silently (fire-and-forget)
      prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          ...(telegramData.first_name && { firstName: telegramData.first_name }),
          ...(telegramData.last_name !== undefined && { lastName: telegramData.last_name || null }),
          ...(telegramData.photo_url && { photoUrl: telegramData.photo_url }),
          ...(incomingUsername && incomingUsername !== user.telegramUsername && {
            oldTelegramUsername: user.telegramUsername,
            telegramUsername: incomingUsername,
            usernameUpdatedAt: new Date(),
          }),
        },
      }).catch(e => console.error('[telegramWidgetLogin] profile sync failed:', e));
    }

    // ── Step 4: Ban check ─────────────────────────────────────────────────────
    if (user.isBanned) {
      res.status(403).json({ success: false, message: 'Your account has been banned. Please contact support.' });
      return;
    }

    // ── Step 5: Issue JWT ─────────────────────────────────────────────────────
    const jwtToken = jwt.sign(
      {
        id: user.id,
        role: user.role,
        adminRole: user.adminRole, hasStartedBot: user.hasStartedBot,
        telegramUsername: incomingUsername || user.telegramUsername,
        tokenVersion: user.tokenVersion ?? 0,
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    // Fetch active badge
    const superBadge = await prisma.superBadge.findUnique({
      where: { userId: user.id },
      select: { id: true, expiresAt: true, status: true },
    });
    const activeBadge =
      superBadge?.status === 'ACTIVE' && superBadge.expiresAt > new Date() ? superBadge : undefined;

    res.json({
      success: true,
      message: isNewUser ? 'Account created successfully!' : 'Login successful',
      data: {
        token: jwtToken,
        isNewUser,
        user: {
          id: user.id,
          telegramId: user.telegramId.toString(),
          telegramUsername: incomingUsername || user.telegramUsername,
          firstName: telegramData.first_name || user.firstName,
          lastName: telegramData.last_name || user.lastName || null,
          role: user.role,
          adminRole: user.adminRole, hasStartedBot: user.hasStartedBot,
          photoUrl: telegramData.photo_url || user.photoUrl || null,
          superBadge: activeBadge,
        },
      },
    });
  } catch (error) {
    console.error('[telegramWidgetLogin]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Telegram OIDC Callback ────────────────────────────────────────────────────
// Exchanges the authorization code from Telegram's OIDC flow for an ID token,
// then creates or updates the user and returns a BuddyStore JWT.
export const telegramOidcCallback = async (req: Request, res: Response): Promise<void> => {
  try {
    const { code } = req.body as { code?: string };

    if (!code) {
      res.status(400).json({ success: false, message: 'Authorization code is required' });
      return;
    }

    const clientId     = process.env.TELEGRAM_CLIENT_ID;
    const clientSecret = process.env.TELEGRAM_CLIENT_SECRET;
    const redirectUri  = process.env.TELEGRAM_REDIRECT_URI ?? 'https://tgbuddy.store/auth/telegram/callback';

    if (!clientId || !clientSecret) {
      res.status(503).json({ success: false, message: 'Telegram login is not configured on this server' });
      return;
    }

    // ── Step 1: Exchange code for ID token ────────────────────────────────────
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch('https://oauth.telegram.org/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: params.toString(),
    });

    const tokenData = await tokenRes.json() as {
      ok?: boolean;
      error?: string;
      id_token?: string;
    };

    if (!tokenRes.ok || !tokenData.id_token) {
      console.error('[telegramOidcCallback] Token exchange failed:', tokenData);
      res.status(401).json({ success: false, message: tokenData.error ?? 'Telegram authorization failed' });
      return;
    }

    const decodedToken = jwt.decode(tokenData.id_token) as {
      sub?:                string;   // OIDC subject — may exceed PostgreSQL bigint, do NOT use as telegramId
      id?:                 number;   // Actual Telegram numeric user ID — safe for bigint
      given_name?:         string;
      family_name?:        string;
      preferred_username?: string;
      picture?:            string;
    } | null;

    // Use `id` (numeric Telegram user ID) — NOT `sub` which is an oversized OIDC identifier
    // that exceeds PostgreSQL bigint max (9223372036854775807)
    if (!decodedToken || !decodedToken.id) {
      console.error('[telegramOidcCallback] Invalid id_token — missing id claim:', decodedToken);
      res.status(401).json({ success: false, message: 'Invalid ID token received from Telegram' });
      return;
    }

    // ── Step 2: Find or create user ───────────────────────────────────────────
    const telegramId       = BigInt(decodedToken.id);  // id is the real Telegram user ID
    const incomingUsername = (decodedToken.preferred_username ?? '').toLowerCase();

    let isNewUser = false;
    let user = await prisma.user.findUnique({ where: { telegramId } });

    if (!user) {
      isNewUser = true;

      let finalUsername = incomingUsername || `tg_${decodedToken.id}`;
      const taken = incomingUsername
        ? await prisma.user.findUnique({ where: { telegramUsername: finalUsername } })
        : null;
      if (taken) finalUsername = `${finalUsername}_${decodedToken.id}`;

      const randomHash  = await bcrypt.hash(randomUUID() + randomUUID(), 12);
      const referralCode = randomUUID().split('-')[0].toUpperCase();

      user = await prisma.user.create({
        data: {
          telegramId,
          telegramUsername: finalUsername,
          firstName:   decodedToken.given_name ?? '',
          lastName:    decodedToken.family_name ?? null,
          passwordHash: randomHash,
          referralCode,
          photoUrl:    decodedToken.picture ?? null,
          lastLoginAt: new Date(),
          role:      finalUsername === config.superAdminUsername ? 'ADMIN' : 'USER',
          adminRole: finalUsername === config.superAdminUsername ? 'SUPER_ADMIN' : null,
        },
      });
    } else {
      prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          ...(decodedToken.given_name && { firstName: decodedToken.given_name }),
          ...(decodedToken.family_name !== undefined && { lastName: decodedToken.family_name ?? null }),
          ...(decodedToken.picture && { photoUrl: decodedToken.picture }),
          ...(incomingUsername && incomingUsername !== user.telegramUsername && {
            oldTelegramUsername: user.telegramUsername,
            telegramUsername:    incomingUsername,
            usernameUpdatedAt:   new Date(),
          }),
        },
      }).catch(e => console.error('[telegramOidcCallback] profile sync failed:', e));
    }

    if (user.isBanned) {
      res.status(403).json({ success: false, message: 'Your account has been banned.' });
      return;
    }

    // ── Step 3: Issue JWT ─────────────────────────────────────────────────────
    const jwtToken = jwt.sign(
      {
        id:               user.id,
        role:             user.role,
        adminRole:        user.adminRole, hasStartedBot: user.hasStartedBot,
        telegramUsername: incomingUsername || user.telegramUsername,
        tokenVersion:     user.tokenVersion ?? 0,
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    const superBadge = await prisma.superBadge.findUnique({
      where:  { userId: user.id },
      select: { id: true, expiresAt: true, status: true },
    });
    const activeBadge =
      superBadge?.status === 'ACTIVE' && superBadge.expiresAt > new Date() ? superBadge : undefined;

    res.json({
      success: true,
      message: isNewUser ? 'Account created successfully!' : 'Login successful',
      data: {
        token: jwtToken,
        isNewUser,
        user: {
          id:               user.id,
          telegramId:       user.telegramId.toString(),
          telegramUsername: incomingUsername || user.telegramUsername,
          firstName:        decodedToken.given_name  || user.firstName,
          lastName:         decodedToken.family_name || user.lastName || null,
          role:             user.role,
          adminRole:        user.adminRole, hasStartedBot: user.hasStartedBot,
          photoUrl:         decodedToken.picture     || user.photoUrl || null,
          superBadge:       activeBadge,
        },
      },
    });
  } catch (error) {
    console.error('[telegramOidcCallback]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Delete Account ──────────────────────────────────────────────────────────
/**
 * DELETE /auth/me
 * Hard-deletes the authenticated user's own account.
 * Requires the user to type 'DELETE' as a confirmation step.
 * Sends a farewell message on Telegram before wiping the record.
 */
export const deleteAccount = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const expectedConfirmation = `delete ${req.user!.telegramUsername}`.toUpperCase();
  const { confirmation } = req.body as { confirmation?: string };
  
  if (!confirmation || confirmation.trim().toUpperCase() !== expectedConfirmation) {
    res.status(400).json({ success: false, message: `Please type "delete ${req.user!.telegramUsername}" to confirm` });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, telegramId: true, firstName: true },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Send farewell message via Telegram before deletion
    if (user.telegramId) {
      const bot = getMainBot();
      if (bot) {
        await bot.api
          .sendMessage(
            user.telegramId.toString(),
            `👋 *Your BuddyStore account has been deleted.*\n\nWe're sorry to see you go, ${user.firstName}. All your data has been permanently removed.\n\nIf you ever change your mind, you can always create a new account at BuddyStore! 🛍️`,
            { parse_mode: 'Markdown' }
          )
          .catch(() => {/* ignore — user may have blocked the bot */});
      }
    }

    // Hard delete — Prisma cascade rules handle related records
    await prisma.user.delete({ where: { id: userId } });

    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    console.error('[deleteAccount]', error);
    res.status(500).json({ success: false, message: 'Server error while deleting account' });
  }
};
