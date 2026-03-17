import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

function createPrismaClient() {
  // In Prisma v7, the `url` field is no longer allowed in schema.prisma.
  // The datasource URL must be passed directly to the PrismaClient constructor
  // at runtime via `datasourceUrl`. prisma.config.ts handles the CLI (migrations).
  return new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
