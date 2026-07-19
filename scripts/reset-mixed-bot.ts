/**
 * Script: reset-mixed-bot.ts
 * Resets the MIXED category Bot record for the new @Buddymixed1Bot.
 * - Updates the bot name to the new username
 * - Resets totalVideos to 0 (new bot has no videos yet)
 * - Clears startedUserIds (old users started the old bot, not the new one)
 * - Turns OFF collectionMode (admin must manually re-enable when ready)
 * - Deletes all Video records that belonged to this bot (old file_ids are invalid on the new bot)
 */

import prisma from '../src/lib/prisma';

async function main() {
  console.log('🔍 Finding MIXED bot record...');

  const mixedBot = await prisma.bot.findUnique({
    where: { category: 'MIXED' },
  });

  if (!mixedBot) {
    console.error('❌ No MIXED bot record found in database. Has it been created in the Admin panel?');
    process.exit(1);
  }

  console.log(`📋 Found bot: "${mixedBot.name}" (id: ${mixedBot.id})`);
  console.log(`   Total videos: ${mixedBot.totalVideos}`);
  console.log(`   Started users: ${mixedBot.startedUserIds.length}`);

  // Step 1: Get all video IDs for this bot
  const botVideos = await prisma.videos.findMany({
    where: { botId: mixedBot.id },
    select: { id: true },
  });
  const videoIds = botVideos.map(v => v.id);
  console.log(`📹 Found ${videoIds.length} videos to clean up`);

  // Step 2: Delete VideoDelivery records first (FK constraint)
  if (videoIds.length > 0) {
    const deletedDeliveries = await prisma.videoDelivery.deleteMany({
      where: { videoId: { in: videoIds } },
    });
    console.log(`🗑️  Deleted ${deletedDeliveries.count} video delivery records`);
  }

  // Step 3: Now safe to delete the videos
  const deletedVideos = await prisma.videos.deleteMany({
    where: { botId: mixedBot.id },
  });
  console.log(`🗑️  Deleted ${deletedVideos.count} old video records (old file_ids are invalid on new bot)`);

  // Step 2: Reset the bot record
  const updated = await prisma.bot.update({
    where: { id: mixedBot.id },
    data: {
      name:           'Buddymixed1Bot',   // new username
      totalVideos:    0,                  // reset — new bot starts empty
      startedUserIds: [],                 // clear — users must /start the new bot
      collectionMode: false,              // admin must turn ON when ready to re-collect
    },
  });

  console.log('\n✅ MIXED bot record updated successfully:');
  console.log(`   Name:           ${updated.name}`);
  console.log(`   Total Videos:   ${updated.totalVideos}`);
  console.log(`   Started Users:  ${updated.startedUserIds.length}`);
  console.log(`   Collection Mode: ${updated.collectionMode ? 'ON' : 'OFF'}`);
  console.log('\n📝 Next steps:');
  console.log('   1. Set BOT_MIXED_TOKEN env var on your server to the new token');
  console.log('   2. Restart the backend server');
  console.log('   3. Go to Admin → Bots → MIXED → Enable Collection Mode');
  console.log('   4. Send your videos to @Buddymixed1Bot to re-populate the library');
}

main()
  .catch((e) => { console.error('❌ Script failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
