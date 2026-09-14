import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RedisReply } from 'rate-limit-redis';
import prisma from '../lib/prisma';

/**
 * Shared rate-limiter instances for BuddyStore.
 *
 * Uses Upstash Redis as the backing store so rate-limit counters
 * survive Render restarts and deploys. Without Redis, in-memory
 * counters reset on every deploy — a bot could hammer the login
 * endpoint, wait for a restart, then hammer again.
 *
 * Limits are per-IP per window. All limiters use `standardHeaders: true`
 * so browsers and API clients receive RateLimit-* response headers.
 */

// ─── Upstash Redis client ────────────────────────────────────────────────────
// Uses Upstash's HTTP REST API. Crucially, we throw when the response contains
// an error (e.g. NOSCRIPT) so rate-limit-redis can catch it and fall back from
// EVALSHA → EVAL, receiving the expected [hits, resetTimeMs] array.
// Falls back gracefully to in-memory if env vars are not set (local dev).
function createRedisStore(prefix: string) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn(`[RateLimit] UPSTASH env vars missing — using in-memory store for "${prefix}"`);
    return undefined; // express-rate-limit defaults to in-memory
  }

  return new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
      const data = await res.json() as { result?: RedisReply; error?: string };
      // Throw on Upstash errors (e.g. NOSCRIPT) so rate-limit-redis can
      // catch them and fall back from EVALSHA to EVAL correctly.
      if (data.error) throw new Error(data.error);
      return data.result as RedisReply;
    },
  });
}

// ─── Login (brute-force protection) ─────────────────────────────────────────
// 10 attempts per 15-minute window keeps humans comfortable while blocking bots.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:auth:'),
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
        where: { telegramUsername: username },
        select: { role: true, adminRole: true },
      });
      
      return user?.adminRole === 'SUPER_ADMIN' || user?.adminRole === 'ORDER_MANAGER';
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
  store: createRedisStore('rl:register:'),
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
  store: createRedisStore('rl:otp:'),
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
  store: createRedisStore('rl:general:'),
  message: {
    success: false,
    message: 'Too many requests. Please slow down.',
  },
});
