import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

function createPrismaClient() {
  // Use the standard Prisma TCP connection pool 
  // This bypasses entirely the @prisma/adapter-neon missing dependencies on Railway
  return new PrismaClient();
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
