import 'dotenv/config';
import http from 'http';
import app from './app';
import config from './config';
import { initSocket } from './lib/socket';
import { createVideoDeliveryWorker } from './jobs/video.queue';
import { startMainBot } from './bots/main.bot';
import { startAllCategoryBots } from './bots/category.bot';
import { startSpecialBot } from './bots/special.bot';
import prisma from './lib/prisma';

async function bootstrap() {
  // ─── Create HTTP server (Express + Socket.io share same port) ──────────────
  const httpServer = http.createServer(app);

  // ─── Initialize Socket.io ───────────────────────────────────────────────────
  initSocket(httpServer);
  console.log('✅ Socket.io initialized');

  // ─── Start Postgres Video Delivery Worker ──────────────────────────
  let worker: ReturnType<typeof createVideoDeliveryWorker> | null = null;
  try {
    worker = createVideoDeliveryWorker();
    console.log('✅ Postgres video delivery worker started');
  } catch (err) {
    console.error('⚠️  Failed to start video delivery queue:', err);
  }

  // ─── Start Telegram Bots ────────────────────────────────────────────────────
  if (config.bots.main) {
    startMainBot();
  } else {
    console.warn('⚠️  MAIN_BOT_TOKEN not set — main bot not started');
  }

  startAllCategoryBots();
  startSpecialBot();

  // ─── Start HTTP Server ──────────────────────────────────────────────────────
  httpServer.listen(config.port, () => {
    console.log('');
    console.log('🚀 ─────────────────────────────────────────────────');
    console.log(`🚀  BuddyStore Backend running on port ${config.port}`);
    console.log(`🚀  Environment: ${config.nodeEnv}`);
    console.log(`🚀  API: http://localhost:${config.port}/api`);
    console.log(`🚀  Health: http://localhost:${config.port}/health`);
    console.log('🚀 ─────────────────────────────────────────────────');
    console.log('');
  });

  // ─── Graceful Shutdown ──────────────────────────────────────────────────────
  const shutdown = async () => {
    console.log('\n⏳ Shutting down gracefully...');
    httpServer.close();
    if (worker) worker.close();
    await prisma.$disconnect();
    console.log('✅ Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}


bootstrap().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
