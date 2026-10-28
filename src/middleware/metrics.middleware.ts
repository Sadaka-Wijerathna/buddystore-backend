/**
 * metrics.middleware.ts — HTTP request instrumentation for prom-client
 *
 * Records:
 *   - buddystore_http_request_duration_ms (histogram, per route)
 *   - buddystore_http_requests_total (counter, per route)
 *   - buddystore_http_active_connections (gauge)
 *
 * Route normalisation:
 *   Express populates req.route.path AFTER the matched handler executes (on
 *   res.finish). We grab the raw path at request time and replace dynamic
 *   segments (:id, :uuid, numeric ids) with their placeholder form so that
 *   /api/v1/orders/abc123 → /api/v1/orders/:id  (cardinality stays bounded).
 */

import { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, httpRequestTotal, activeConnections } from '../lib/metrics';

// Replace dynamic URL segments to prevent unbounded label cardinality
function normaliseRoute(path: string): string {
  return path
    .replace(/\/[0-9a-f]{24,}/gi, '/:id')   // MongoDB-style ObjectIds / UUIDs
    .replace(/\/\d+/g, '/:id')               // Pure numeric IDs
    .replace(/\/[0-9a-f-]{36}/gi, '/:uuid'); // Standard UUIDs
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  activeConnections.inc();

  const startMs = Date.now();

  res.on('finish', () => {
    activeConnections.dec();

    // Use matched Express route pattern when available, fall back to raw path
    const routePath = (req.route?.path as string | undefined)
      ? `${req.baseUrl || ''}${req.route.path}`
      : normaliseRoute(req.path);

    const labels = {
      method: req.method,
      route: routePath,
      status_code: String(res.statusCode),
    };

    const durationMs = Date.now() - startMs;
    httpRequestDuration.observe(labels, durationMs);
    httpRequestTotal.inc(labels);
  });

  next();
}

