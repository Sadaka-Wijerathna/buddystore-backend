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

// Middleware
import { errorHandler, notFound } from './middleware/error.middleware';
import { sanitizeInput } from './middleware/sanitize.middleware';

const app = express();

app.disable('x-powered-by');

// ─── Core Middleware ──────────────────────────────────────────────────────────
app.use(helmet());

// Support comma-separated list of allowed origins in FRONTEND_URL
// Example: FRONTEND_URL=https://buddystore.vercel.app,http://localhost:3000
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Static Files (payment receipts) ─────────────────────────────────────────
app.use('/uploads', express.static(path.join(process.cwd(), config.uploadDir)));

// ─── Health Check & Root ──────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ success: true, message: 'BuddyStore API is running', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({ success: true, message: 'BuddyStore API is running', timestamp: new Date().toISOString() });
});

// ─── Telegram Webhook Routes ──────────────────────────────────────────────────
// Mounted dynamically from server.ts AFTER initCategoryBots() populates the
// registry. See server.ts → mountWebhookRouter().
// MUST be mounted BEFORE sanitizeInput so the Telegram JSON payload is not mutated.
app.use('/webhooks', (req, res, next) => {
  console.log(`[Webhook] 📥 Incoming request: ${req.method} ${req.url}`);
  next();
});

// ─── API Middleware (applied only after webhook routes) ───────────────────────
app.use(sanitizeInput);

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/admin', pdfAdminRoutes);
app.use('/api/v1/public', publicRoutes);

// ─── Error Handling ────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
