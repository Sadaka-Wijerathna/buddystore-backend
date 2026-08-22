import prisma from './src/lib/prisma';

async function seedPlans() {
  const firstPlan = await prisma.superBadgePlan.findFirst({ orderBy: { order: 'asc' } });
  if (firstPlan) {
    await prisma.superBadgePlan.update({
      where: { id: firstPlan.id },
      data: {
        name: 'Monthly Pass',
        durationDays: 30,
        price: 15
      }
    });
    console.log('Successfully updated the primary plan to Monthly Pass!');
  } else {
    // create if not exists
    await prisma.superBadgePlan.create({
      data: {
        name: 'Monthly Pass',
        durationDays: 30,
        price: 15,
        isActive: true,
        order: 1
      }
    });
  }
  console.log('Successfully seeded SuperBadge plans!');
}

seedPlans().catch(console.error).finally(() => prisma.$disconnect());
