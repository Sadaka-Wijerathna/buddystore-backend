const prisma = require('./dist/lib/prisma').default || require('./dist/lib/prisma');

async function run() {
  await prisma.user.updateMany({
    where: { telegramUsername: 'buddysender2' },
    data: { tokenVersion: { increment: 1 } }
  });
  console.log("Token version incremented for buddysender2");
  await prisma.$disconnect();
}

run();
