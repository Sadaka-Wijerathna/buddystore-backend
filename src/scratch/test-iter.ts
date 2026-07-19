import 'dotenv/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import prisma from '../lib/prisma';

async function test() {
  const sessionSetting = await prisma.setting.findFirst({
    where: { key: { startsWith: 'telegram_mtproto_session_' } },
  });
  if (!sessionSetting) {
    console.log('No session found');
    return;
  }

  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : undefined;
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.log('No API credentials');
    return;
  }

  console.log('Connecting client...');
  const client = new TelegramClient(new StringSession(sessionSetting.value), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  const chatIdentifier = "3986179031"; // Restricted channel ID
  console.log(`Resolving chat: ${chatIdentifier}`);
  
  const dialogs = await client.getDialogs({ limit: 500 });
  const match = dialogs.find((d) => {
    const e = d.entity as any;
    return e?.id?.toString() === chatIdentifier;
  });

  if (!match || !match.entity) {
    console.log('Could not find channel in dialogs!');
    await client.disconnect();
    return;
  }

  const entity = match.entity;
  console.log(`Found entity: title="${match.name}"`);

  console.log('Testing iterMessages WITH video filter...');
  let filterCount = 0;
  try {
    for await (const message of client.iterMessages(entity, {
      filter: new Api.InputMessagesFilterVideo(),
      limit: 600,
    })) {
      filterCount++;
      if (filterCount % 100 === 0) {
        console.log(`  Fetched ${filterCount} videos so far... (Msg ID: ${message.id})`);
      }
    }
    console.log(`Filter Scan Finished: found ${filterCount} videos (limit requested: 600)`);
  } catch (err: any) {
    console.error('Error during filter iterMessages:', err);
  }

  await client.disconnect();
}

test().catch(console.error);
