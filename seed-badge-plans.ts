import prisma from './src/lib/prisma';

async function seedPlans() {
  await prisma.superBadgePlan.createMany({
    data: [
      {
        name: 'Weekly Pass',
        durationDays: 7,
        price: 5,
        isActive: true,
        order: 1
      },
      {
        name: 'Monthly Pass',
        durationDays: 30,
        price: 15,
        isActive: true,
        order: 2
      },
      {
        name: 'Yearly Pass',
        durationDays: 365,
        price: 100,
        isActive: true,
        order: 3
      }
    ],
    skipDuplicates: true
  });
  console.log('Successfully seeded SuperBadge plans!');
}

seedPlans().catch(console.error).finally(() => prisma.$disconnect());
