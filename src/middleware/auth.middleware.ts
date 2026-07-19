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

    // Primary: Bearer header. Fallback: ?token= query param (for <video> stream URLs)
    let token: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query.token && typeof req.query.token === 'string') {
      token = req.query.token;
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

    // ─── Back-fill IP / device / last-login for users that don't have it yet ──
    // Fire-and-forget: only triggers when lastIpAddress is null so there's no
    // extra DB write on every request once the data is populated.
    if (!user.lastIpAddress) {
      prisma.user.update({
        where: { id: user.id },
        data: {
          lastIpAddress: getClientIp(req),
          deviceType: getDeviceType(req),
          lastLoginAt: new Date(),
        },
      }).catch(e => console.error('[authenticate] IP back-fill failed:', e));
    }

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
  // Hardcoded safety for @buddyseller
  const isHardcodedSuperAdmin = req.user?.telegramUsername?.toLowerCase() === 'buddyseller';

  if (!req.user || req.user.role !== 'ADMIN' || (req.user.adminRole !== 'SUPER_ADMIN' && !isHardcodedSuperAdmin)) {
    res.status(403).json({ success: false, message: 'Super Admin access required' });
    return;
  }
  next();
};
