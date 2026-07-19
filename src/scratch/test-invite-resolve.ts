import 'dotenv/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import prisma from '../lib/prisma';

async function test() {
  const sessionSetting = await prisma.setting.findFirst({
    where: { key: { startsWith: 'telegram_mtproto_session_' } },
  });
  if (!sessionSetting) {
    console.log('No session found in DB');
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

  const inviteLink = "https://t.me/+stTKMzVwV2QwYTgx"; // Replace with a test invite link
  const hashMatch = inviteLink.match(/(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/);
  if (!hashMatch) {
    console.log("Invalid invite link");
    await client.disconnect();
    return;
  }

  const hash = hashMatch[1];
  console.log(`Checking invite link with hash: ${hash}`);

  try {
    const inviteInfo = await client.invoke(
      new Api.messages.CheckChatInvite({ hash })
    ) as any;

    console.log("Invite info class:", inviteInfo.className);
    if (inviteInfo instanceof Api.ChatInviteAlready) {
      const chat = inviteInfo.chat as any;
      console.log("Already a member! Chat entity:", chat.title || chat.username, "ID:", chat.id.toString());
    } else if (inviteInfo instanceof Api.ChatInvite) {
      console.log("Not a member yet. Title:", inviteInfo.title);
      // Try to join
      const joinResult = await client.invoke(
        new Api.messages.ImportChatInvite({ hash })
      ) as any;
      console.log("Join result class:", joinResult.className);
      if (joinResult?.chats?.[0]) {
        console.log("Joined successfully! Chat:", joinResult.chats[0].title);
      }
    }
  } catch (err: any) {
    console.error("Error during check/join:", err);
  }

  await client.disconnect();
}

test().catch(console.error);
