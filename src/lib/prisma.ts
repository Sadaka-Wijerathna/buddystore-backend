import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

function createPrismaClient() {
  return new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
  } as any);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
