import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaNeonHttp } from '@prisma/adapter-neon';

// The Neon HTTP Serverless adapter doesn't support interactive transactions OR migrations safely
// We only use it for standard client queries. For migrations/deployments we use the standard Postgres driver.
function createPrismaClient() {
  // Temporary fix for Railway: just use the standard Prisma TCP connection pool
  // This avoids tricky "Transactions are not supported in HTTP mode" issues
  // and allows the `prisma migrate deploy` script to run cleanly on startup.
  return new PrismaClient();
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
