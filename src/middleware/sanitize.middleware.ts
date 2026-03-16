import { Request, Response, NextFunction } from 'express';

/**
 * Strip HTML tags and common XSS vectors from a string.
 * Keeps the text content, removes all `<...>` markup.
 */
function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')       // remove HTML tags
    .replace(/javascript:/gi, '')  // remove javascript: protocol
    .replace(/on\w+\s*=/gi, '')    // remove inline event handlers (onclick=, etc.)
    .trim();
}

/**
 * Recursively sanitise all string values in an object / array.
 */
function sanitizeValue(val: unknown): unknown {
  if (typeof val === 'string') return stripTags(val);
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = sanitizeValue(v);
    }
    return out;
  }
  return val;
}

/**
 * Express middleware — sanitises all string fields in `req.body`
 * and `req.query` to prevent stored / reflected XSS.
 *
 * Passwords are intentionally excluded so users can have any characters.
 */
const PASSWORD_FIELDS = new Set(['password', 'newPassword', 'currentPassword', 'confirmPassword']);

export const sanitizeInput = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.body && typeof req.body === 'object') {
    for (const [key, value] of Object.entries(req.body)) {
      if (PASSWORD_FIELDS.has(key)) continue; // don't touch passwords
      (req.body as Record<string, unknown>)[key] = sanitizeValue(value);
    }
  }

  if (req.query && typeof req.query === 'object') {
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        (req.query as Record<string, unknown>)[key] = stripTags(value);
      }
    }
  }

  next();
};
