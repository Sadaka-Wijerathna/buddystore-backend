import 'dotenv/config';
import prisma from '../src/lib/prisma';

async function main() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "Bot" ADD COLUMN "bannerUrl" TEXT;');
    console.log('Successfully added bannerUrl column!');
  } catch (error: any) {
    console.error('Error (might already exist):', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
