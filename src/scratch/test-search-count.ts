import 'dotenv/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import prisma from '../lib/prisma';

async function test() {
  const sessionSetting = await prisma.setting.findUnique({
    where: { key: 'telegram_mtproto_session_748f7592-4466-4902-a581-53036297d3f1' },
  });
  if (!sessionSetting) {
    console.log('No session');
    return;
  }

  const client = new TelegramClient(new StringSession(sessionSetting.value), parseInt(process.env.TELEGRAM_API_ID!, 10), process.env.TELEGRAM_API_HASH!, {
    connectionRetries: 5,
  });
  await client.connect();

  const chatIdentifier = "3986179031"; // VIP ADMIN HUB (NEW SET)
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

  // Let's call search with video filter, limit 1 to see the total property
  const result = await client.invoke(
    new Api.messages.Search({
      peer: entity,
      q: '',
      filter: new Api.InputMessagesFilterVideo(),
      minDate: 0,
      maxDate: 0,
      offsetId: 0,
      addOffset: 0,
      limit: 1,
      maxId: 0,
      minId: 0,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — GramJS BigInteger vs native bigint
      hash: BigInt(0),
    })
  ) as any;

  console.log('Search result class:', result.className);
  console.log('Search result count/total:', result.count);

  await client.disconnect();
}

test().catch(console.error);
