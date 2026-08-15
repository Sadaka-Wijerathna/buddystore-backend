import prisma from '../lib/prisma';

async function checkState() {
  const total = await prisma.videos.count({ where: { category: 'MOM_SON' } });
  const bot = await prisma.bot.findUnique({ where: { category: 'MOM_SON' }, select: { totalVideos: true } });
  console.log('Total MOM_SON videos in DB:', total);
  console.log('Bot totalVideos counter    :', bot?.totalVideos);
  await prisma.$disconnect();
}
checkState().catch(e => { console.error(e); process.exit(1); });
