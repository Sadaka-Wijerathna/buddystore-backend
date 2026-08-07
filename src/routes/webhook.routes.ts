import { Router } from 'express';
import { webhookCallback } from 'grammy';
import { mainBot } from '../bots/main.bot';
import { categoryBots } from '../bots/category.bot';
import { specialBot } from '../bots/special.bot';
import config from '../config';

// ─── Webhook Router Factory ────────────────────────────────────────────────────
// Called AFTER initCategoryBots() has populated the categoryBots registry so
// that dynamic route registration reflects the actual bot instances in memory.
//
// SECURITY: If WEBHOOK_SECRET is set, grammY validates the
// X-Telegram-Bot-Api-Secret-Token header on every request, rejecting anything
// that isn't genuinely from Telegram.
//
// IMPORTANT: The returned router must be mounted in app BEFORE the sanitizeInput
// middleware so the Telegram JSON payload is never mutated.

export function createWebhookRouter(): Router {
  const router = Router();

  const secret = config.webhookSecret || undefined;

  // ── Main bot ────────────────────────────────────────────────────────────────
  router.post(
    '/main',
    webhookCallback(mainBot, 'express', { secretToken: secret })
  );

  // ── Category bots (dynamic — populated from DB at startup) ──────────────────
  for (const [, categoryBot] of Object.entries(categoryBots)) {
    if (categoryBot.bot) {
      // Derive slug the same way registerAllCategoryBotWebhooks does
      const slug = categoryBot.name.replace(/^@/, '').toLowerCase();
      router.post(
        `/${slug}`,
        webhookCallback(categoryBot.bot, 'express', { secretToken: secret })
      );
      console.log(`📡 Registered webhook route: POST /webhooks/${slug}`);
    }
  }

  // ── Special bot ─────────────────────────────────────────────────────────────
  if (specialBot) {
    router.post('/special', webhookCallback(specialBot, 'express', { secretToken: secret }));
  }

  return router;
}
