/**
 * Prisma Configuration — Neon Serverless Adapter
 *
 * This file configures Prisma to use the Neon HTTP adapter for migrations.
 * It is automatically picked up by the Prisma CLI (v7+) when running:
 *   - `npx prisma migrate dev`
 *   - `npx prisma migrate deploy`
 *   - `npx prisma db push`
 *
 * Why it exists:
 *   The production database is hosted on Neon (serverless Postgres).
 *   Neon requires an HTTP-based adapter (`@prisma/adapter-neon`) instead of
 *   a traditional TCP connection for migrations. Without this file, Prisma
 *   migrations would fail against the Neon database.
 *
 * Requires:
 *   - DATABASE_URL set in .env (Neon connection string)
 *   - `@prisma/adapter-neon` and `@neondatabase/serverless` packages
 *
 * @see https://www.prisma.io/docs/orm/overview/databases/neon
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { PrismaNeonHttp } from '@prisma/adapter-neon';

export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL!,
  },
  migrate: {
    async adapter() {
      const connectionString = process.env.DATABASE_URL!;
      return new PrismaNeonHttp(connectionString, {});
    },
  },
});
