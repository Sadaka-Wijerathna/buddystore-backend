/**
 * update-bot-names.ts — One-time script to rename category bots in the DB
 *
 * Updates the `name` field of each bot row to match the new Telegram handles.
 * Safe to re-run — uses upsert-style updateMany which is a no-op if already correct.
 *
 * Usage:
 *   npx ts-node src/scripts/update-bot-names.ts
 */
import 'dotenv/config';
import prisma from '../lib/prisma';

const updates: { category: string; name: string }[] = [
  { category: 'MIXED',      name: 'Buddymixed1Bot'  },
  { category: 'MOM_SON',    name: 'BuddyMs1Bot'     },
  { category: 'SRI_LANKAN', name: 'BuddySLBot'      },
  { category: 'CCTV',       name: 'Buddycctv1Bot'   },
  { category: 'RAPE',       name: 'BuddyRkpeBot'    },
  // PUBLIC kept as-is — add later
];

async function run() {
  console.log('🔄 Updating bot names in DB...\n');

  for (const u of updates) {
    const result = await prisma.bot.updateMany({
      where: { category: u.category as any },
      data:  { name: u.name },
    });
    if (result.count > 0) {
      console.log(`  ✅ ${u.category} → ${u.name}`);
    } else {
      console.log(`  ⚠️  ${u.category}: no row found (not seeded yet)`);
    }
  }

  console.log('\n✅ Done!');
  await prisma.$disconnect();
}

run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
