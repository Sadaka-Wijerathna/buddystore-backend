# BuddyStore Backend

Express + Prisma + Telegram bot backend for BuddyStore.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in your values
cp .env.example .env

# 3. Run database migrations
npx prisma migrate dev

# 4. Seed the bots table (REQUIRED — orders won't work without this)
npm run seed:bots

# 5. Start the dev server
npm run dev
```

## Required Environment Variables

See [`.env.example`](.env.example) for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Neon recommended) |
| `REDIS_URL` | Redis for BullMQ job queues |
| `JWT_SECRET` | Secret for signing auth tokens |
| `MAIN_BOT_TOKEN` | Telegram bot token for registration & password reset |
| `BOT_*_TOKEN` | One token per category bot (6 total) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name for receipt uploads |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript + generate Prisma client |
| `npm start` | Run compiled production build |
| `npm run seed:bots` | **Required first-time setup** — seed the 6 category bots |
| `npm run set:admin` | Promote a user to admin role |
| `npm run prisma:migrate` | Run Prisma migrations |
| `npm run prisma:studio` | Open Prisma Studio GUI |

## Project Structure

```
src/
├── bots/           # Telegram bot handlers (main + category bots)
├── config/         # App configuration (reads from .env)
├── controllers/    # Route handlers (auth, orders, admin, notifications)
├── jobs/           # BullMQ job queues (video delivery)
├── lib/            # Shared utilities (prisma, cloudinary, socket.io)
├── middleware/     # Express middleware (auth)
├── routes/         # Express route definitions
├── scripts/        # One-off scripts (seed-bots, set-admin)
├── app.ts          # Express app setup
└── server.ts       # Server entry point
```

## Notes

- **`prisma.config.ts`** (project root): Configures Prisma to use the Neon HTTP adapter for migrations. Required for Neon-hosted databases. See the file for details.
- **Bot seeding**: The `bots` table must be populated before any orders can be created. Run `npm run seed:bots` after the first migration.
