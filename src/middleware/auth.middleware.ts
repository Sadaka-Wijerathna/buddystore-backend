import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import prisma from '../lib/prisma';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    adminRole?: string | null;
    telegramUsername: string;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return ips.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? req.ip ?? 'unknown';
}

function getDeviceType(req: Request): string {
  const ua = (req.headers['user-agent'] ?? '').toLowerCase();
  if (/mobile|android|iphone|ipad|ipod|blackberry|windows phone/i.test(ua)) return 'Mobile';
  if (/tablet|ipad/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

// ─── Authenticate any logged-in user ───────────────────────────────────────
export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    // JWT must ONLY come via the Authorization: Bearer <token> header.
    // ⚠️  Never accept JWT in query params (?token=) — they are visible in server
    // logs, browser history, and Referer headers, making token theft trivial.
    //
    // For <video src> stream URLs that cannot send headers, create a short-lived
    // one-time media token (separate DB table, 60-second TTL) and exchange it
    // for video access via a dedicated /api/v1/media/:token endpoint.
    let token: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    if (!token) {
      res.status(401).json({ success: false, message: 'No token provided' });
      return;
    }

    const decoded = jwt.verify(token, config.jwt.secret) as {
      id: string;
      role: string;
      adminRole?: string | null;
      telegramUsername: string;
      tokenVersion?: number;
    };

    // Verify user still exists
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) {
      res.status(401).json({ success: false, message: 'User not found' });
      return;
    }

    // Check if user is banned
    if (user.isBanned) {
      res.status(403).json({ success: false, message: 'Your account has been banned. Please contact support.' });
      return;
    }

    // Check token version — banning increments this, instantly invalidating old tokens
    if ((decoded.tokenVersion ?? 0) !== user.tokenVersion) {
      res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
      return;
    }

    // Privacy: IP address and device type are intentionally NOT stored.
    // Only lastLoginAt is kept (non-identifying, useful for session hygiene).

    req.user = { id: decoded.id, role: decoded.role, adminRole: decoded.adminRole, telegramUsername: decoded.telegramUsername };
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// ─── Require admin role ────────────────────────────────────────────────────
export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403).json({ success: false, message: 'Admin access required' });
    return;
  }
  next();
};

// ─── Require Super Admin role ──────────────────────────────────────────────
// Only users with adminRole === 'SUPER_ADMIN' can proceed.
export const requireSuperAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  // Use config.superAdminUsername (from SUPER_ADMIN_USERNAME env var) instead of a
  // hardcoded string so the super-admin identity can be changed without a code deploy.
  const isHardcodedSuperAdmin = req.user?.telegramUsername?.toLowerCase() === config.superAdminUsername;

  if (!req.user || req.user.role !== 'ADMIN' || (req.user.adminRole !== 'SUPER_ADMIN' && !isHardcodedSuperAdmin)) {
    res.status(403).json({ success: false, message: 'Super Admin access required' });
    return;
  }
  next();
};
