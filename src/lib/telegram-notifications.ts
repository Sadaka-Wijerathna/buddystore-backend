import prisma from './prisma';
import { mainBot } from '../bots/main.bot';

export async function notifyAdminsOfNewOrder(
  orders: any[], 
  user: any, 
  totalAmount: number, 
  paymentMethod: string, 
  receiptUrl?: string | null
) {
  try {
    const superAdmins = await prisma.user.findMany({
      where: { adminRole: 'SUPER_ADMIN' },
      select: { telegramId: true }
    });

    if (superAdmins.length === 0) return;

    const orderCount = orders.length;
    const categoryList = orders.map(o => o.category).join(', ');

    let caption = `🚨 <b>NEW ORDER RECEIVED!</b>\n\n`;
    caption += `👤 <b>Customer:</b> <a href="https://t.me/${user.telegramUsername}">${user.firstName} ${user.lastName || ''}</a> (@${user.telegramUsername})\n`;
    caption += `📦 <b>Categories (${orderCount}):</b> ${categoryList}\n`;
    caption += `💰 <b>Total Amount:</b> ${totalAmount} LKR\n`;
    caption += `💳 <b>Payment Method:</b> ${paymentMethod}\n`;
    if (orders.length > 0 && orders[0].id) {
        caption += `\n🆔 <b>Order ID:</b> <code>${orders[0].id}</code>\n`;
    }

    for (const admin of superAdmins) {
      try {
        // Only send photo if it's a real valid URL and not the wallet indicator
        if (receiptUrl && receiptUrl !== 'PAID_VIA_WALLET' && receiptUrl.startsWith('http')) {
          await mainBot.api.sendPhoto(admin.telegramId.toString(), receiptUrl, {
            caption,
            parse_mode: 'HTML'
          });
        } else {
          await mainBot.api.sendMessage(admin.telegramId.toString(), caption, {
            parse_mode: 'HTML'
          });
        }
      } catch (err) {
        console.error(`[notifyAdmins] Failed to send to admin ${admin.telegramId}`, err);
      }
    }
  } catch (error) {
    console.error('[notifyAdmins] Error fetching admins or sending notification:', error);
  }
}
