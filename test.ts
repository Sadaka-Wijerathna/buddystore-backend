import prisma from './src/lib/prisma';
async function main() {
  const plans = await prisma.superBadgePlan.findMany();
  console.log('Plans:', plans);
}
main().catch(console.error).finally(() => prisma.$disconnect());
