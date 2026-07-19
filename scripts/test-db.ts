import prisma from '../src/lib/prisma';

async function run() {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN' },
    select: { telegramUsername: true, firstName: true, adminRole: true }
  });
  console.log(JSON.stringify(admins, null, 2));
  await prisma.$disconnect();
}

run();
