import 'dotenv/config';
import prisma from '../lib/prisma';
import { Bot } from 'grammy';
import config from '../config';

const MUMBAI_IP = '15.252.173.37';

async function main() {
  console.log('--- Setting Main Bot Webhook with Mumbai IP ---');
  try {
    const mainBot = new Bot(config.bots.main);
    const me = await mainBot.api.getMe();
    await mainBot.api.setWebhook(`https://api.tgbuddy.store/webhooks/main`, {
      ip_address: MUMBAI_IP,
      secret_token: config.webhookSecret || undefined,
      allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member']
    });
    const info = await mainBot.api.getWebhookInfo();
    console.log(`Main Bot @${me.username}: OK | Webhook URL: ${info.url} | IP: ${info.ip_address} | Pending: ${info.pending_update_count}`);
  } catch (e: any) {
    console.error('Main Bot error:', e.message);
  }

  console.log('\n--- Setting Category Bots Webhooks with Mumbai IP ---');
  const bots = await prisma.bot.findMany({});
  for (const b of bots) {
    if (!b.token) continue;
    try {
      const catBot = new Bot(b.token);
      const me = await catBot.api.getMe();
      const slug = me.username.toLowerCase();
      await catBot.api.setWebhook(`https://api.tgbuddy.store/webhooks/${slug}`, {
        ip_address: MUMBAI_IP,
        secret_token: config.webhookSecret || undefined,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member']
      });
      const info = await catBot.api.getWebhookInfo();
      console.log(`Bot @${me.username} (${b.category}): OK | URL: ${info.url} | IP: ${info.ip_address} | Pending: ${info.pending_update_count}`);
    } catch (e: any) {
      console.log(`Bot ${b.name} (${b.category}): ${e.message}`);
    }
  }

  process.exit(0);
}

main().catch(console.error);
