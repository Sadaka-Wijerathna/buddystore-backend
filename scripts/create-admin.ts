import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const telegramUsername = 'SadakaWijerathna';
  const password = 'admin123'; // Temporary password — change it after login
  const hash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { telegramUsername },
    create: {
      telegramId: BigInt(999999999), // Placeholder Telegram ID — update if needed
      telegramUsername,
      firstName: 'Sadaka',
      lastName: 'Wijerathna',
      passwordHash: hash,
      role: 'ADMIN',
    },
    update: {
      role: 'ADMIN',
      passwordHash: hash,
    },
  });

  console.log(`✅ Admin account ready:`);
  console.log(`   Username: @${user.telegramUsername}`);
  console.log(`   Role:     ${user.role}`);
  console.log(`   Password: ${password}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
