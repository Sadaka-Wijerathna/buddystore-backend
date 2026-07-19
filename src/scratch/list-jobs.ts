import 'dotenv/config';
import prisma from '../lib/prisma';

async function test() {
  const jobs = await prisma.telegramImportJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  for (const j of jobs) {
    console.log(`Job: ID=${j.id} CreatedAt=${j.createdAt} Source=${j.sourceChat} Status=${j.status} Progress=${j.progress}/${j.total}`);
    console.log(`Message: ${j.message}`);
    console.log(`Error: ${j.error}`);
    console.log('Logs:');
    try {
      const logs = typeof j.logs === 'string' ? JSON.parse(j.logs) : j.logs;
      if (Array.isArray(logs)) {
        logs.forEach(l => console.log(`  ${l}`));
      }
    } catch (_) {
      console.log(`  ${j.logs}`);
    }
    console.log('-'.repeat(50));
  }
}

test().catch(console.error);
