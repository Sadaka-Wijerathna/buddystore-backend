import prisma from '../lib/prisma';
import { mainBot } from '../bots/main.bot';
import { dispatchNotification } from '../controllers/notification.controller';

let sweeperInterval: NodeJS.Timeout | null = null;

export const startRecoverySweeper = () => {
  console.log('🧹 [Jobs] Abandoned Cart Recovery Sweeper started. (Runs every 10m)');

  // Run every 10 minutes (600,000 ms)
  sweeperInterval = setInterval(async () => {
    try {
      // 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      const abandonedOrders = await prisma.order.findMany({
         where: {
           status: 'INITIATED',
           recoverySent: false,
           createdAt: { lt: twoHoursAgo }
         },
         include: { user: true }
      });

      if (abandonedOrders.length > 0) {
        console.log(`🧹 [Recovery] Found ${abandonedOrders.length} abandoned orders!`);
      }

      for (const order of abandonedOrders) {
         try {
           // 1. Send push notification natively to OS
           await dispatchNotification(
             order.userId,
             'wallet_bonus', // repurpose wallet icon / alert type
             'Cart Abandoned!',
             `Hey! You forgot to upload your payment receipt for ${order.category}! Come back to checkout so your videos can be delivered.`
           );

           // 2. Send Telegram API ping
           const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',')[0] : 'https://buddystore.vercel.app';
           const message = `⚠️ *Hey! You forgot your videos!*\n\nYou started an order for *${order.videoCount} ${order.category}* videos but never uploaded the payment receipt!\n\nPlease login to the website at ${frontendUrl}/dashboard and complete your checkout so we can deliver them to you immediately.`;
           
           await mainBot.api.sendMessage(String(order.user.telegramId), message, { parse_mode: 'Markdown' });

           // 3. Mark as sent to prevent spamming it every 10 minutes
           await prisma.order.update({
             where: { id: order.id },
             data: { recoverySent: true }
           });

           console.log(`🧹 [Recovery] Sent recovery messages for order ${order.id} to user @${order.user.telegramUsername}`);
         } catch (err) {
           console.error('[Recovery Sweeper] Error processing order', order.id, err);
         }
      }
    } catch (error) {
      console.error('[Recovery Sweeper] Error fetching stalled orders:', error);
    }
  }, 10 * 60 * 1000);
}

export const stopRecoverySweeper = () => {
    if (sweeperInterval) {
        clearInterval(sweeperInterval);
        console.log('🧹 [Jobs] Recovery Sweeper stopped.');
    }
}
