/**
 * metrics.ts — Prometheus prom-client registry for BuddyStore Backend
 *
 * Exposes:
 *   - Default Node.js process metrics (CPU, memory, GC, event loop lag, fds)
 *   - HTTP request duration histogram per route/method/status
 *   - HTTP request total counter per route/method/status
 *   - Active HTTP connections gauge
 *
 * Usage:
 *   - Import `httpRequestDuration` in your request middleware to start/end timers
 *   - Mount GET /metrics using `metricsHandler` in app.ts (admin-protected)
 */

import client from 'prom-client'; // prom-client v15 — compatible with Node 20

// ── Registry ──────────────────────────────────────────────────────────────────
export const register = new client.Registry();

// Add default Node.js metrics (event loop lag, GC, memory, CPU, fds, active handles/requests)
client.collectDefaultMetrics({
  register,
  prefix: 'buddystore_',
  labels: { service: 'buddystore-backend' },
});

// ── HTTP Request Duration Histogram ──────────────────────────────────────────
// Records per-route latency in milliseconds.
// Buckets chosen for a typical REST API + Telegram bot backend:
//   5ms = fast DB hit, 25ms = normal DB query, 100ms = slow DB, 500ms = timeout risk
export const httpRequestDuration = new client.Histogram({
  name: 'buddystore_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

// ── HTTP Request Counter ──────────────────────────────────────────────────────
export const httpRequestTotal = new client.Counter({
  name: 'buddystore_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// ── Active HTTP Connections Gauge ─────────────────────────────────────────────
export const activeConnections = new client.Gauge({
  name: 'buddystore_http_active_connections',
  help: 'Number of currently active HTTP connections',
  registers: [register],
});

// ── Bot Pending Updates Gauge ─────────────────────────────────────────────────
export const botPendingUpdates = new client.Gauge({
  name: 'buddystore_bot_pending_updates',
  help: 'Telegram bot pending update count',
  labelNames: ['bot_name'] as const,
  registers: [register],
});

// ── DB Query Latency Gauge ────────────────────────────────────────────────────
export const dbQueryLatency = new client.Gauge({
  name: 'buddystore_db_query_latency_ms',
  help: 'Last measured PostgreSQL ping latency in milliseconds',
  registers: [register],
});

// ── Video Importer VPC Latency Gauge ─────────────────────────────────────────
export const importerVpcLatency = new client.Gauge({
  name: 'buddystore_importer_vpc_latency_ms',
  help: 'Last measured VPC latency to video-importer service in milliseconds',
  registers: [register],
});

// ── Metrics handler ───────────────────────────────────────────────────────────
// Mount this on GET /metrics (behind admin auth in app.ts)
export async function metricsHandler(_req: unknown, res: any): Promise<void> {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
}
