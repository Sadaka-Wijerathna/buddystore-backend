/**
 * Bot Seeder — Migrates bot tokens into the DB `bots` table.
 */
import 'dotenv/config';
import prisma from '../lib/prisma';

const defaultBots = [
  { name: 'Buddymixed1Bot', category: 'MIXED',      label: 'Mixed',            token: process.env.BOT_MIXED_TOKEN || '8544985570:AAHtvQ5z4cWtkiP1v0rdx90Y50910bGPmzs' },
  { name: 'BuddyMs1Bot',    category: 'MOM_SON',    label: 'Mom & Son',        token: process.env.BOT_MOM_SON_TOKEN || '8770814599:AAEZs40qf6hjzMV_a_LKp169xREWuppCWrw' },
  { name: 'BuddySLBot',     category: 'SRI_LANKAN', label: 'Sri Lankan',       token: process.env.BOT_SRI_LANKAN_TOKEN || '8630340326:AAEhYB9RfKJoaKbbqMRY-hXHRmaKs5SqOK8' },
  { name: 'Buddycctv1Bot',  category: 'CCTV',       label: 'CCTV & Hidden Cam',token: process.env.BOT_CCTV_TOKEN || '8744583330:AAE6PUSBpjhpvADuNy6ibxnsbPeEMIOEPm0' },
  { name: 'BuddyPublicBot', category: 'PUBLIC',     label: 'Public',           token: process.env.BOT_PUBLIC_TOKEN || '8223042148:AAGaa5piQYqbahsbZ_MARIeDXvFozPSSXuc' },
  { name: 'BuddyRkpeBot',   category: 'RAPE',       label: 'Special RP',       token: process.env.BOT_RAPE_TOKEN || '8459826755:AAHCfoeqMKYzWmtHrS8epo_b48FlETQ8IPw' },
];

async function seed() {
  console.log('🌱 Syncing bot tokens to database...');

  for (const bot of defaultBots) {
    const existing = await prisma.bot.findUnique({ where: { category: bot.category } });
    if (existing) {
      await prisma.bot.update({
        where: { id: existing.id },
        data: {
          token: existing.token || bot.token,
          label: existing.label || bot.label,
        },
      });
      console.log(`  ✅ Updated token for existing bot: ${bot.name} (${bot.category})`);
    } else {
      await prisma.bot.create({ data: bot });
      console.log(`  ✅ Created bot with token: ${bot.name} (${bot.category})`);
    }
  }

  console.log('\n✅ Bot tokens stored in database successfully!\n');
}

seed()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
