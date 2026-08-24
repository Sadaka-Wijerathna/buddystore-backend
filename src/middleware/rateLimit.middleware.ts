import rateLimit from 'express-rate-limit';
import prisma from '../lib/prisma';

/**
 * Shared rate-limiter instances for BuddyStore.
 *
 * Limits are per-IP per window. All limiters use `standardHeaders: true`
 * so browsers and API clients receive RateLimit-* response headers.
 */

// ─── Login (brute-force protection) ─────────────────────────────────────────
// 10 attempts per 15-minute window keeps humans comfortable while blocking bots.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please wait 15 minutes and try again.',
  },
  skipSuccessfulRequests: false,
  skip: async (req) => {
    try {
      const username = req.body?.username;
      if (!username) return false;
      
      const user = await prisma.user.findUnique({
        where: { username },
        select: { role: true },
      });
      
      return user?.role === 'SUPER_ADMIN' || user?.role === 'ORDER_MANAGER';
    } catch {
      return false;
    }
  },
});

// ─── Registration step 1 (check-username) ────────────────────────────────────
// Slightly more lenient since users may mistype their username a few times.
export const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many registration attempts. Please wait 10 minutes and try again.',
  },
});

// ─── OTP / Password reset ─────────────────────────────────────────────────────
// Tight limit — OTP brute-force is dangerous.
export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests. Please wait 15 minutes and try again.',
  },
});

// ─── General API abuse protection ────────────────────────────────────────────
// Applied as a catch-all — very generous so normal usage is never affected.
export const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please slow down.',
  },
});
