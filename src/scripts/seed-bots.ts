/**
 * Bot Seeder — run once to populate the bots table with all 6 categories
 * Usage: npx ts-node src/scripts/seed-bots.ts
 */
import 'dotenv/config';
import prisma from '../lib/prisma';

const bots = [
  { name: 'BuddyMixedBot',     category: 'MIXED'       as const },
  { name: 'BuddyMomSonBot',    category: 'MOM_SON'     as const },
  { name: 'BuddySriLankanBot', category: 'SRI_LANKAN'  as const },
  { name: 'BuddyCCTVBot',      category: 'CCTV'        as const },
  { name: 'BuddyPublicBot',    category: 'PUBLIC'      as const },
  { name: 'BuddyRapeBot',      category: 'RAPE'        as const },
];

async function seed() {
  console.log('🌱 Seeding bots...');

  for (const bot of bots) {
    const existing = await prisma.bot.findUnique({ where: { category: bot.category } });
    if (existing) {
      console.log(`  ⏭️  ${bot.name} already exists — skipping`);
      continue;
    }
    await prisma.bot.create({ data: bot });
    console.log(`  ✅ Created: ${bot.name}`);
  }

  console.log('\n✅ Bot seeding complete!\n');
  await prisma.$disconnect();
}

seed().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

