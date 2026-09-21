# BuddyStore Backend

Express + Prisma + Telegram bot backend for BuddyStore.

## Features

- **Robust REST API**: Built on Express.js with Prisma ORM.
- **Telegram MTProto Integration**: For massive-scale bot management.
- **Background Jobs**: BullMQ for reliable video delivery.
- **Comprehensive Test Suite**: Jest + Supertest covering core logic without a live DB.
- **API Documentation**: Interactive Swagger UI built-in.

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

## Testing

The test suite uses `jest`, `ts-jest`, and `supertest`. The `PrismaClient` is fully mocked using `jest-mock-extended` so you do not need a live database to run the tests.

```bash
# Run the test suite once
npm test

# Run the test suite in watch mode
npm run test:watch
```

## API Documentation

Swagger UI is configured for this project. When running in development, navigate to:
[http://localhost:4000/api/v1/docs](http://localhost:4000/api/v1/docs)

All major endpoints are documented using JSDoc `@swagger` annotations inside `src/routes/`. To disable the docs in production, set `ENABLE_DOCS=false` in your `.env`.

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
| `npm test` | Run automated test suite |
| `npm run seed:bots` | **Required first-time setup** — seed the 6 category bots |
| `npm run set:admin` | Promote a user to admin role |
| `npm run prisma:migrate` | Run Prisma migrations |
| `npm run prisma:studio` | Open Prisma Studio GUI |

## Project Structure

```
src/
├── __tests__/      # Jest test files and mocks
├── bots/           # Telegram bot handlers (main + category bots)
├── config/         # App configuration (reads from .env)
├── controllers/    # Route handlers (auth, orders, admin, notifications)
├── jobs/           # BullMQ job queues (video delivery)
├── lib/            # Shared utilities (prisma, cloudinary, socket.io)
├── middleware/     # Express middleware (auth)
├── routes/         # Express route definitions (contains Swagger annotations)
├── scripts/        # One-off scripts (seed-bots, set-admin)
├── app.ts          # Express app setup (Swagger UI mounted here)
├── swagger.ts      # Swagger / OpenAPI configuration
└── server.ts       # Server entry point
```

## Notes

- **`prisma.config.ts`** (project root): Configures Prisma to use the Neon HTTP adapter for migrations. Required for Neon-hosted databases. See the file for details.
- **Bot seeding**: The `bots` table must be populated before any orders can be created. Run `npm run seed:bots` after the first migration.
