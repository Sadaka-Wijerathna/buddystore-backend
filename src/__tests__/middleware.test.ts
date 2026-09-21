import { Request, Response, NextFunction } from 'express';
import { authenticate, requireAdmin, requireSuperAdmin } from '../middleware/auth.middleware';
import { fakeUser, fakeAdmin, expiredToken, userToken, adminToken } from './helpers/auth.helper';
import prisma from '../lib/prisma';
import { MockPrisma } from './__mocks__/prisma';

// Type cast prisma to our mock type
const mockPrisma = prisma as unknown as MockPrisma;

describe('Middleware Tests', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      headers: {},
      ip: '127.0.0.1',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('authenticate', () => {
    it('should return 401 if no auth header', async () => {
      await authenticate(req as any, res as any, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ success: false, message: 'No token provided' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if token is expired', async () => {
      req.headers!.authorization = `Bearer ${expiredToken()}`;
      await authenticate(req as any, res as any, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Invalid or expired token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if user not found in DB', async () => {
      req.headers!.authorization = `Bearer ${userToken()}`;
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await authenticate(req as any, res as any, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ success: false, message: 'User not found' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if tokenVersion mismatches', async () => {
      req.headers!.authorization = `Bearer ${userToken()}`;
      // token has version 0, db says 1
      mockPrisma.user.findUnique.mockResolvedValue({ ...fakeUser, tokenVersion: 1 } as any);
      await authenticate(req as any, res as any, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Session expired. Please log in again.' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next() and set req.user on success', async () => {
      req.headers!.authorization = `Bearer ${userToken()}`;
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      await authenticate(req as any, res as any, next);
      expect(next).toHaveBeenCalled();
      expect((req as any).user.id).toBe(fakeUser.id);
    });
  });

  describe('requireAdmin', () => {
    it('should return 403 if user is not admin', () => {
      (req as any).user = { role: 'USER' };
      requireAdmin(req as any, res as any, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next() if user is admin', () => {
      (req as any).user = { role: 'ADMIN' };
      requireAdmin(req as any, res as any, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
