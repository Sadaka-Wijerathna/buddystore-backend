const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "Bot" ADD COLUMN "bannerUrl" TEXT;');
    console.log('Successfully added bannerUrl column!');
  } catch (error) {
    console.error('Error (might already exist):', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
