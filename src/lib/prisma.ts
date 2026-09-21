import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

function createPrismaClient() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Prevent "too many clients" errors on Render/Neon free tier.
    // Free PostgreSQL plans cap at ~25 total connections across all services.
    max: 5,              // max 5 concurrent DB connections
    idleTimeoutMillis: 60_000,        // close idle connections after 60s (< Supabase's ~5m cutoff)
    connectionTimeoutMillis: 20_000,  // fail fast if no connection available in 20s
    // ── Supabase pooler keepalive ───────────────────────────────────────────
    // Supabase's connection pooler silently drops idle TCP connections after
    // ~5 minutes, causing "Connection terminated unexpectedly" errors when the
    // pool tries to reuse a stale socket. TCP keepalive packets prevent this.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000, // start sending keepalives after 10s idle
  });

  // Prevent idle connection terminations from crashing the Node.js process
  pool.on('error', (err) => {
    console.error('Unexpected error on idle database client', err);
  });


  const adapter = new PrismaPg(pool);

  // ── BigInt serialization ────────────────────────────────────────────────────
  // Replaces the global `BigInt.prototype.toJSON` monkey-patch in app.ts.
  // Scoped to the Prisma client: only user.telegramId is a BigInt field.
  // TypeScript now types telegramId as `string` wherever it is read from DB.
  return new PrismaClient({ adapter }).$extends({
    result: {
      user: {
        telegramId: {
          needs: { telegramId: true },
          compute(user) {
            return user.telegramId.toString();
          },
        },
      },
    },
  });
}

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedPrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
