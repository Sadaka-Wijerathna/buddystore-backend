/**
 * Set a user's role to ADMIN by Telegram username
 *
 * Usage:
 *   npx ts-node src/scripts/set-admin.ts <telegramUsername>
 *   npx ts-node src/scripts/set-admin.ts buddyseller
 *
 * Bug 14 Fix: Username is now read from process.argv[2] instead of being
 * hardcoded — no need to edit source to promote a different admin.
 */
import 'dotenv/config';
import prisma from '../lib/prisma';

const TARGET_USERNAME = process.argv[2];

if (!TARGET_USERNAME) {
  console.error('❌ Usage: ts-node src/scripts/set-admin.ts <telegramUsername>');
  process.exit(1);
}

async function main() {
  console.log(`🔍 Looking up @${TARGET_USERNAME}...`);

  const user = await prisma.user.findFirst({
    where: { telegramUsername: { equals: TARGET_USERNAME, mode: 'insensitive' } },
  });

  if (!user) {
    console.error(`❌ No user found with username @${TARGET_USERNAME}`);
    process.exit(1);
  }

  if (user.role === 'ADMIN') {
    console.log(`✅ @${TARGET_USERNAME} already has ADMIN role.`);
    await prisma.$disconnect();
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { role: 'ADMIN' },
  });

  console.log(`✅ @${TARGET_USERNAME} has been granted ADMIN role!`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
