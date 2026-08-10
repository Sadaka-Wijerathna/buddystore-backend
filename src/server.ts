import 'dotenv/config';
import http from 'http';
import app from './app';
import config from './config';
import { initSocket } from './lib/socket';
import { createVideoDeliveryWorker } from './jobs/video.queue';
import { registerMainBotWebhook, deregisterMainBotWebhook } from './bots/main.bot';
import { registerAllCategoryBotWebhooks, deregisterAllCategoryBotWebhooks } from './bots/category.bot';
import { registerSpecialBotWebhook, deregisterSpecialBotWebhook } from './bots/special.bot';
import { createWebhookRouter } from './routes/webhook.routes';
import prisma from './lib/prisma';
import { initCronJobs } from './jobs/cron';
import { startRecoverySweeper, stopRecoverySweeper } from './jobs/recoverySweeper.job';
import { startBroadcastWorker, stopBroadcastWorker } from './jobs/broadcast.worker';

async function bootstrap() {
  const httpServer = http.createServer(app);

  initCronJobs();
  startRecoverySweeper();
  startBroadcastWorker();

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

  // ─── Register Telegram Bot Webhooks ────────────────────────────────────────
  // In webhook mode Telegram pushes updates to our HTTPS endpoints — no long-polling.
  // This prevents 409 Conflict errors caused by multiple getUpdates connections on
  // Render restarts, and avoids being flagged as spam infrastructure.
  if (config.shouldStartBots) {
    if (!config.webhookBaseUrl) {
      console.error('❌ WEBHOOK_BASE_URL is not set. Bots will not receive updates.');
      console.error('   Set it to the public HTTPS root of this service, e.g.:');
      console.error('   https://buddystore-backend.onrender.com');
    } else {
      const base = config.webhookBaseUrl;
      const secret = config.webhookSecret || undefined;

      await registerMainBotWebhook(base, secret);
      await registerAllCategoryBotWebhooks(base, secret);
      await registerSpecialBotWebhook(base, secret);

      // Mount webhook router AFTER bots are initialized so the categoryBots
      // registry is fully populated before routes are registered.
      // (Moved to app.ts to avoid being trapped behind the 404 handler)
      console.log('✅ All bot webhooks registered');
    }
  } else {
    console.log('🤖 Bots are DISABLED (SHOULD_START_BOTS=false)');
  }

  // ─── Start HTTP Server ──────────────────────────────────────────────────────
  httpServer.listen(config.port, '0.0.0.0', () => {
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

    // Deregister webhooks first so Telegram stops sending updates immediately
    await Promise.all([
      deregisterMainBotWebhook(),
      deregisterAllCategoryBotWebhooks(),
      deregisterSpecialBotWebhook(),
    ]);
    stopRecoverySweeper();
    stopBroadcastWorker();

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
