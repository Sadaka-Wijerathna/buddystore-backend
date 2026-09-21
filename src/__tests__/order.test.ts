import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';
import { MockPrisma } from './__mocks__/prisma';
import { fakeUser, userToken } from './helpers/auth.helper';

const mockPrisma = prisma as unknown as MockPrisma;

describe('Order API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/orders/category-limits', () => {
    it('should return 401 if unauthenticated', async () => {
      const res = await request(app).get('/api/v1/orders/category-limits?category=MIXED');
      expect(res.status).toBe(401);
    });

    it('should return 400 if category is missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      const res = await request(app)
        .get('/api/v1/orders/category-limits')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(400);
    });

    it('should return limits for valid category', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      mockPrisma.bot.findUnique.mockResolvedValue({ minVideoCount: 10, totalVideos: 100, pricePerVideo: 10 } as any);
      
      // Mocks for Promise.all count queries
      mockPrisma.videos.count.mockResolvedValue(100);
      mockPrisma.videoDelivery.count.mockResolvedValue(20);

      const res = await request(app)
        .get('/api/v1/orders/category-limits?category=MIXED')
        .set('Authorization', `Bearer ${userToken()}`);
        
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.available).toBe(80); // 100 total - 20 received
      expect(res.body.data.alreadyReceived).toBe(20);
    });
  });

  describe('GET /api/v1/orders', () => {
    it('should return empty list if no orders', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      mockPrisma.order.findMany.mockResolvedValue([]);
      
      const res = await request(app)
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${userToken()}`);
        
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('POST /api/v1/orders/initiate', () => {
    it('should return 400 if missing fields', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(fakeUser as any);
      
      const res = await request(app)
        .post('/api/v1/orders/initiate')
        .set('Authorization', `Bearer ${userToken()}`)
        .send({ category: 'MIXED' }); // missing videoCount
        
      expect(res.status).toBe(400);
    });
  });
});
