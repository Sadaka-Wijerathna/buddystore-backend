import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';
import { MockPrisma } from './__mocks__/prisma';
import { fakeUser, fakeAdmin, userToken, adminToken } from './helpers/auth.helper';

const mockPrisma = prisma as unknown as MockPrisma;

describe('Admin API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/admin/users', () => {
    it('should return 403 for non-admin users', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      
      const res = await request(app)
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${userToken()}`);
        
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('should return users list for admin', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeAdmin as any);
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.user.findMany.mockResolvedValue([fakeUser as any]);
      
      const res = await request(app)
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${adminToken()}`);
        
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.users.length).toBe(1);
    });
  });

  describe('GET /api/v1/admin/analytics', () => {
    it('should return 403 for non-admin', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      const res = await request(app)
        .get('/api/v1/admin/analytics')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });
  });
});
