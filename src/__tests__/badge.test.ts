import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';
import { MockPrisma } from './__mocks__/prisma';
import { fakeUser, userToken } from './helpers/auth.helper';

const mockPrisma = prisma as unknown as MockPrisma;

describe('Badge API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/badge/plans', () => {
    it('should return 401 if unauthenticated', async () => {
      const res = await request(app).get('/api/v1/badge/plans');
      expect(res.status).toBe(401);
    });

    it('should return sorted active plans', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      mockPrisma.superBadgePlan.findMany.mockResolvedValue([
        { id: '1', name: 'Pro', isActive: true, order: 1 } as any
      ]);

      const res = await request(app)
        .get('/api/v1/badge/plans')
        .set('Authorization', `Bearer ${userToken()}`);
        
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].name).toBe('Pro');
    });
  });

  describe('GET /api/v1/badge/status', () => {
    it('should return null if user has no badge', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      mockPrisma.superBadge.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/badge/status')
        .set('Authorization', `Bearer ${userToken()}`);
        
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeNull();
    });

    it('should return active badge status', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      mockPrisma.superBadge.findUnique.mockResolvedValue({
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 86400000) // Tomorrow
      } as any);

      const res = await request(app)
        .get('/api/v1/badge/status')
        .set('Authorization', `Bearer ${userToken()}`);
        
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isActive).toBe(true);
    });
  });
});
