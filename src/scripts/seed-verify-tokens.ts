/**
 * Seed Verified Bot Tokens for @buddyseller
 * Usage: npm run seed:verify-tokens
 */
import 'dotenv/config';
import prisma from '../lib/prisma';
import { Category } from '@prisma/client';

const TARGET_USERNAME = 'buddyseller';
const CATEGORIES: Category[] = ['MIXED', 'MOM_SON', 'SRI_LANKAN', 'CCTV', 'PUBLIC', 'RAPE'];

async function main() {
  console.log(`🌱 Seeding verified tokens for @${TARGET_USERNAME}...`);

  const user = await prisma.user.findFirst({
    where: { telegramUsername: { equals: TARGET_USERNAME, mode: 'insensitive' } },
  });

  if (!user) {
    console.error(`❌ No user found with username @${TARGET_USERNAME}. Please start the bot first.`);
    process.exit(1);
  }

  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year expiration for testing

  for (const category of CATEGORIES) {
    const existing = await prisma.botVerifyToken.findFirst({
      where: { userId: user.id, category },
    });

    if (existing) {
      await prisma.botVerifyToken.update({
        where: { id: existing.id },
        data: { verified: true, expiresAt },
      });
      console.log(`  ✅ Verified token updated for: ${category}`);
    } else {
      await prisma.botVerifyToken.create({
        data: {
          userId: user.id,
          category,
          verified: true,
          expiresAt,
        },
      });
      console.log(`  ✅ Verified token created for: ${category}`);
    }
  }

  console.log('\n✅ Token seeding complete!\n');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
