import 'dotenv/config';
import prisma from '../lib/prisma';

async function test() {
  const settings = await prisma.setting.findMany({});
  console.log('Settings:');
  for (const s of settings) {
    if (s.key.includes('session')) {
      console.log(`- Key: ${s.key}, Value length: ${s.value.length}`);
    } else {
      console.log(`- Key: ${s.key}, Value: ${s.value}`);
    }
  }
}

test().catch(console.error);
