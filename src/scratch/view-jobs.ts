import prisma from '../lib/prisma';

async function main() {
  const jobs = await prisma.telegramImportJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log("RECENT JOBS:");
  for (const job of jobs) {
    console.log(`ID: ${job.id}`);
    console.log(`Status: ${job.status}`);
    console.log(`Source: ${job.sourceChat}`);
    console.log(`Target: ${job.targetBot}`);
    console.log(`Message: ${job.message}`);
    console.log(`Error: ${job.error}`);
    console.log(`Logs:`);
    try {
      const parsedLogs = typeof job.logs === 'string' ? JSON.parse(job.logs || '[]') : (job.logs as any || []);
      parsedLogs.forEach((l: string) => console.log(`  ${l}`));
    } catch (e) {
      console.log(`  Raw Logs: ${job.logs}`);
    }
    console.log("-".repeat(40));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
