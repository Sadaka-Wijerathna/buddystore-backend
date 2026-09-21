import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';
import { MockPrisma } from './__mocks__/prisma';
import { fakeUser, userToken } from './helpers/auth.helper';

const mockPrisma = prisma as unknown as MockPrisma;

describe('Auth API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/auth/login', () => {
    it('should return 400 if fields are missing', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 401 for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'nobody', password: 'password123' });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /api/v1/auth/refresh-token', () => {
    it('should refresh token for valid user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      
      const res = await request(app)
        .post('/api/v1/auth/refresh-token')
        .set('Authorization', `Bearer ${userToken()}`);
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
    });

    it('should reject unauthenticated request', async () => {
      const res = await request(app).post('/api/v1/auth/refresh-token');
      expect(res.status).toBe(401);
    });
  });
});
