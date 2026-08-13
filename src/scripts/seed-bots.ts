/**
 * Bot Seeder — Migrates bot tokens into the DB `bots` table.
 *
 * Usage: npm run seed:bots
 *
 * Requires these environment variables to be set (in .env or the shell):
 *   BOT_MIXED_TOKEN, BOT_MOM_SON_TOKEN, BOT_SRI_LANKAN_TOKEN,
 *   BOT_CCTV_TOKEN, BOT_PUBLIC_TOKEN, BOT_RAPE_TOKEN
 *
 * Bug 13 Fix: Removed all hardcoded fallback bot tokens.
 * They were committed to source control, exposing live production credentials.
 * If a token env var is missing the bot row is skipped with a warning.
 */
import 'dotenv/config';
import prisma from '../lib/prisma';

interface BotSeed {
  name: string;
  category: string;
  label: string;
  tokenEnvKey: string;
}

const defaultBots: BotSeed[] = [
  { name: 'Buddymixed1Bot', category: 'MIXED',      label: 'Mixed',             tokenEnvKey: 'BOT_MIXED_TOKEN'      },
  { name: 'BuddyMs1Bot',    category: 'MOM_SON',    label: 'Mom & Son',         tokenEnvKey: 'BOT_MOM_SON_TOKEN'    },
  { name: 'BuddySLBot',     category: 'SRI_LANKAN', label: 'Sri Lankan',        tokenEnvKey: 'BOT_SRI_LANKAN_TOKEN' },
  { name: 'Buddycctv1Bot',  category: 'CCTV',       label: 'CCTV & Hidden Cam', tokenEnvKey: 'BOT_CCTV_TOKEN'       },
  { name: 'BuddyPublicBot', category: 'PUBLIC',     label: 'Public',            tokenEnvKey: 'BOT_PUBLIC_TOKEN'     },
  { name: 'BuddyRkpeBot',   category: 'RAPE',       label: 'Special RP',        tokenEnvKey: 'BOT_RAPE_TOKEN'       },
];

async function seed() {
  console.log('🌱 Syncing bot tokens to database...\n');

  let skipped = 0;

  for (const bot of defaultBots) {
    const token = process.env[bot.tokenEnvKey];

    if (!token) {
      console.warn(`  ⚠️  ${bot.category}: $${bot.tokenEnvKey} is not set — skipping.`);
      skipped++;
      continue;
    }

    const existing = await prisma.bot.findUnique({ where: { category: bot.category as any } });
    if (existing) {
      await prisma.bot.update({
        where: { id: existing.id },
        data: {
          token: existing.token || token,
          label: existing.label || bot.label,
        },
      });
      console.log(`  ✅ Updated token for existing bot: ${bot.name} (${bot.category})`);
    } else {
      await prisma.bot.create({ data: { name: bot.name, category: bot.category as any, label: bot.label, token } });
      console.log(`  ✅ Created bot with token: ${bot.name} (${bot.category})`);
    }
  }

  if (skipped > 0) {
    console.warn(`\n  ⚠️  ${skipped} bot(s) skipped due to missing env vars. Set them in your .env file.`);
  }

  console.log('\n✅ Bot token sync complete!\n');
}

seed()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
