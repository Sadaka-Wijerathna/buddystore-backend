import 'dotenv/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import prisma from '../lib/prisma';

async function test() {
  const sessionSetting = await prisma.setting.findUnique({
    where: { key: 'telegram_mtproto_session_748f7592-4466-4902-a581-53036297d3f1' },
  });
  if (!sessionSetting) {
    console.log('No session found');
    return;
  }

  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : undefined;
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.log('No API credentials in env');
    return;
  }

  console.log('Connecting client...');
  const client = new TelegramClient(new StringSession(sessionSetting.value), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  console.log('Getting dialogs...');
  const dialogs = await client.getDialogs({});
  console.log(`Found ${dialogs.length} dialogs`);

  for (const d of dialogs) {
    const e = d.entity;
    if (e) {
      console.log(`Dialog: Title="${d.name}" ID="${e.id ? e.id.toString() : 'no-id'}" Type="${e.className}"`);
    }
  }
  
  await client.disconnect();
}

test().catch(console.error);
