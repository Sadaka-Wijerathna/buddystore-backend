import { Router } from 'express';
import { webhookCallback } from 'grammy';
import { mainBot } from '../bots/main.bot';
import { categoryBots } from '../bots/category.bot';
import { specialBot } from '../bots/special.bot';
import config from '../config';

// ─── Webhook Router ───────────────────────────────────────────────────────────
// Telegram pushes bot updates to these endpoints via HTTPS POST.
// Each route maps to one bot instance's grammY update handler.
//
// SECURITY: If WEBHOOK_SECRET is set, grammY validates the X-Telegram-Bot-Api-Secret-Token
// header on every request, rejecting anything that isn't genuinely from Telegram.
//
// IMPORTANT: This router must be mounted in app.ts BEFORE the sanitizeInput
// middleware so the Telegram JSON payload is never mutated.

const router = Router();

const secret = config.webhookSecret || undefined;

// ── Main bot ──────────────────────────────────────────────────────────────────
router.post(
  '/main',
  webhookCallback(mainBot, 'express', { secretToken: secret })
);

// ── Category bots ─────────────────────────────────────────────────────────────
if (categoryBots.MIXED.bot) {
  router.post('/mixed',      webhookCallback(categoryBots.MIXED.bot!,      'express', { secretToken: secret }));
}
if (categoryBots.MOM_SON.bot) {
  router.post('/mom-son',    webhookCallback(categoryBots.MOM_SON.bot!,    'express', { secretToken: secret }));
}
if (categoryBots.SRI_LANKAN.bot) {
  router.post('/sri-lankan', webhookCallback(categoryBots.SRI_LANKAN.bot!, 'express', { secretToken: secret }));
}
if (categoryBots.CCTV.bot) {
  router.post('/cctv',       webhookCallback(categoryBots.CCTV.bot!,       'express', { secretToken: secret }));
}
if (categoryBots.PUBLIC.bot) {
  router.post('/public',     webhookCallback(categoryBots.PUBLIC.bot!,     'express', { secretToken: secret }));
}
if (categoryBots.RAPE.bot) {
  router.post('/rape',       webhookCallback(categoryBots.RAPE.bot!,       'express', { secretToken: secret }));
}

// ── Special bot ───────────────────────────────────────────────────────────────
if (specialBot) {
  router.post('/special', webhookCallback(specialBot, 'express', { secretToken: secret }));
}

export default router;
