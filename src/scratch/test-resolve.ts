import 'dotenv/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import prisma from '../lib/prisma';

async function resolveEntity(client: TelegramClient, chatIdentifier: string) {
  const privateLinkMatch = chatIdentifier.match(
    /(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/
  );

  if (privateLinkMatch) {
    const hash = privateLinkMatch[1];
    try {
      const result = await client.invoke(
        new Api.messages.ImportChatInvite({ hash })
      ) as any;
      if (result?.chats?.[0]) {
        return result.chats[0];
      }
    } catch (err: any) {
      if (!err.errorMessage?.includes('USER_ALREADY_PARTICIPANT')) {
        throw new Error(`Failed to resolve private invite link: ${err.message || err.errorMessage}`);
      }
      const dialogs = await client.getDialogs({ limit: 200 });
      const match = dialogs.find((d) => {
        const e = d.entity as any;
        return e?.accessHash && chatIdentifier.includes(hash);
      });
      if (match?.entity) return match.entity;
    }
  }

  if (/^-?\d+$/.test(chatIdentifier)) {
    try {
      const dialogs = await client.getDialogs({ limit: 500 });
      const match = dialogs.find((d) => {
        const e = d.entity as any;
        return e?.id?.toString() === chatIdentifier;
      });
      if (match?.entity) return match.entity;
    } catch (dialogErr) {
      console.warn('Could not look up entity from dialogs, falling back to getEntity:', dialogErr);
    }
  }

  return client.getEntity(chatIdentifier);
}

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

  try {
    const entity = await resolveEntity(client, "3986179031");
    console.log('RESOLVED ENTITY:', entity.className, 'ID:', entity.id.toString());
  } catch (err: any) {
    console.error('FAILED TO RESOLVE:', err);
  }

  await client.disconnect();
}

test().catch(console.error);
