
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const id = '71155a3f-9a86-4aa4-bffa-622054ccf537';
  const pdf = await prisma.freePdf.findUnique({ where: { id } });
  console.log(JSON.stringify(pdf, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
