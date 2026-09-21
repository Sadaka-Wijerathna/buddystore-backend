import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';
import { MockPrisma } from './__mocks__/prisma';

const mockPrisma = prisma as unknown as MockPrisma;

describe('Public API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/public/bank-accounts', () => {
    it('should return publicly accessible bank accounts', async () => {
      mockPrisma.bankAccount.findMany.mockResolvedValue([
        { id: '1', bankName: 'Test Bank', isActive: true } as any
      ]);

      const res = await request(app).get('/api/v1/public/bank-accounts');
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
    });
  });

  describe('GET /api/v1/public/pdf-categories', () => {
    it('should return nested pdf categories without auth', async () => {
      mockPrisma.pdfCategory.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/v1/public/pdf-categories');
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });
});
