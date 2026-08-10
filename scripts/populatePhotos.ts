import prisma from '../src/lib/prisma';
import config from '../src/config';
import { Bot } from 'grammy';

const bot = new Bot(config.bots.main);

async function fetchTelegramPhotoUrl(telegramId: bigint | string): Promise<string | null> {
  try {
    const photos = await bot.api.getUserProfilePhotos(Number(telegramId), { limit: 1 });
    if (!photos.total_count || !photos.photos[0]?.[0]) return null;

    const fileId = photos.photos[0][0].file_id;
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;

    const botToken = config.bots.main;
    return `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  } catch (error) {
    console.error(`Failed to fetch photo for ${telegramId}`, error);
    return null;
  }
}

async function main() {
  console.log('Fetching all users...');
  const users = await prisma.user.findMany({ where: { photoUrl: null } });
  console.log(`Found ${users.length} users without a photoUrl.`);

  for (const user of users) {
    console.log(`Fetching photo for @${user.telegramUsername}...`);
    const photoUrl = await fetchTelegramPhotoUrl(user.telegramId);
    if (photoUrl) {
      await prisma.user.update({
        where: { id: user.id },
        data: { photoUrl }
      });
      console.log(`Updated photo for @${user.telegramUsername}`);
    } else {
      console.log(`No photo found for @${user.telegramUsername}`);
    }
  }
  console.log('Done!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
