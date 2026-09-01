import express from 'express';

// ─── BigInt Serialization Fix ────────────────────────────────────────────────
// Prisma returns BigInt for telegramId, which JSON.stringify doesn't support by default.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import config from './config';

// Routes
import authRoutes from './routes/auth.routes';
import orderRoutes from './routes/order.routes';
import adminRoutes from './routes/admin.routes';
import publicRoutes from './routes/public.routes';
import pdfAdminRoutes from './routes/pdf.routes';
import badgeRoutes from './routes/badge.routes';

// Middleware
import { errorHandler, notFound } from './middleware/error.middleware';
import { sanitizeInput } from './middleware/sanitize.middleware';
import { generalLimiter } from './middleware/rateLimit.middleware';
import { authenticate } from './middleware/auth.middleware';

const app = express();

// ─── Reverse Proxy Trust ──────────────────────────────────────────────────────
// Render (and most PaaS providers) sit behind a load balancer that sets
// X-Forwarded-For. Without this, express-rate-limit cannot identify the real
// client IP and throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

app.disable('x-powered-by');

// ─── Core Middleware ──────────────────────────────────────────────────────────
// Fix #10 + Privacy headers: Strict CSP + Referrer-Policy + Permissions-Policy
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", "data:", "https://api.telegram.org", "https://res.cloudinary.com"],
      mediaSrc:    ["'self'", "https://res.cloudinary.com"],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'", "data:"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // Privacy: no-referrer stops our server URL leaking to any external service
  referrerPolicy: { policy: 'no-referrer' },
  // Disable browser APIs that could fingerprint or track users
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: false, // keep false — needed for Telegram embeds
}));

// Extra privacy header — Permissions-Policy disables tracking-adjacent browser features
app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()'
  );
  next();
});


// Support comma-separated list of allowed origins in FRONTEND_URL
// Example: FRONTEND_URL=https://tgbuddy.store,http://localhost:3000
const allowedOrigins = config.frontendUrl
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

console.log(`[CORS] Allowed origins: ${allowedOrigins.join(', ')}`);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, mobile apps, Render health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Log blocked origins to help diagnose CORS issues in production
    console.warn(`[CORS] ❌ Blocked origin: ${origin} — add it to FRONTEND_URL env var`);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));

// ─── Static Files (payment receipts) ─────────────────────────────────────────
// ⚠️  SECURITY: Receipts are NOT served as public static files.
// They are accessed via /api/v1/admin/receipts/:filename (admin-authenticated).
// The raw uploads directory is intentionally NOT mounted publicly.

// ─── Health Check & Root ──────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ success: true, message: 'BuddyStore API is running', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({ success: true, message: 'BuddyStore API is running', timestamp: new Date().toISOString() });
});

// ─── Telegram Webhook Routes ──────────────────────────────────────────────────
let _webhookRouter: express.Router | null = null;

/**
 * Call this after registering a new category bot at runtime so the cached
 * webhook router is discarded. The next incoming Telegram update will
 * trigger a fresh rebuild that includes the new bot's route.
 */
export function resetWebhookRouter(): void {
  _webhookRouter = null;
  console.log('[Webhook] 🔄 Router cache cleared — will rebuild on next request');
}

app.use('/webhooks', (req, res, next) => {
  console.log(`[Webhook] 📥 Incoming request: ${req.method} ${req.url}`);
  if (!_webhookRouter) {
    // Lazy-load to ensure categoryBots are populated by server.ts bootstrap
    const { createWebhookRouter } = require('./routes/webhook.routes');
    _webhookRouter = createWebhookRouter();
  }
  if (_webhookRouter) {
    _webhookRouter(req, res, next);
  } else {
    next();
  }
});

// ─── API Middleware (applied only after webhook routes) ───────────────────────
app.use(sanitizeInput);

// ─── Routes ────────────────────────────────────────────────────────────────────
// Apply the general rate-limiter to all API routes (catch-all abuse protection)
app.use('/api/v1/auth', generalLimiter, authRoutes);
app.use('/api/v1/orders', generalLimiter, orderRoutes);
app.use('/api/v1/admin', generalLimiter, adminRoutes);
app.use('/api/v1/admin', generalLimiter, pdfAdminRoutes);
app.use('/api/v1/public', generalLimiter, publicRoutes);
app.use('/api/v1/badge', generalLimiter, badgeRoutes);

// ─── Protected Receipt Serving ────────────────────────────────────────────────
// Only authenticated users (any role) may view receipt images.
// URL pattern: /api/v1/uploads/:filename
app.use('/api/v1/uploads', authenticate, express.static(path.join(process.cwd(), config.uploadDir)));


// ─── Error Handling ────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
