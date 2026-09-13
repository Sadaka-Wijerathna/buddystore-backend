/**
 * Sentry instrumentation — must be imported BEFORE everything else in server.ts.
 * This file initialises the Sentry SDK so it can capture errors from all
 * subsequent imports (Express, Prisma, Telegram bots, Socket.io, etc.).
 */
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // ── Tracing ────────────────────────────────────────────────────────────────
  // 10% of requests traced in production to stay within the free 5M spans/mo.
  // Raise to 1.0 temporarily when debugging a specific slow endpoint.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // ── Environment tagging ────────────────────────────────────────────────────
  environment: process.env.NODE_ENV || 'development',

  // ── Privacy ────────────────────────────────────────────────────────────────
  // Do not send raw HTTP request bodies (may contain passwords / payment data)
  dataCollection: {
    httpBodies: [],   // strip request/response bodies from error reports
  },

  // ── Integrations ──────────────────────────────────────────────────────────
  integrations: [
    // Automatically captures unhandled promise rejections
    Sentry.onUncaughtExceptionIntegration(),
    Sentry.onUnhandledRejectionIntegration(),
  ],
});

console.log(`[Sentry] Initialised (env: ${process.env.NODE_ENV || 'development'})`);
