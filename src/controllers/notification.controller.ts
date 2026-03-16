import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

type NotificationType = 'order_placed' | 'order_confirmed' | 'order_delivering' | 'order_completed' | 'order_rejected';

interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  desc: string;
  time: string;
  orderId: string;
  createdAt: Date;
  read: boolean;
}

function categoryLabel(category: string): string {
  const map: Record<string, string> = {
    MIXED: 'Mixed',
    MOM_SON: 'Mom & Son',
    SRI_LANKAN: 'Sri Lankan',
    CCTV: 'CCTV',
    PUBLIC: 'Public',
    RAPE: 'Special RP',
  };
  return map[category] ?? category;
}

function shortId(id: string): string {
  return '#' + id.slice(0, 6).toUpperCase();
}

// ─── GET /orders/notifications ─────────────────────────────────────────────────
export const getNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    const notifications: Notification[] = [];

    for (const order of orders) {
      const cat = categoryLabel(order.category);
      const sid = shortId(order.id);

      // ── Always add "Order placed" event (based on createdAt)
      notifications.push({
        id: `placed-${order.id}`,
        type: 'order_placed',
        title: `Order ${sid} Placed`,
        desc: `Your ${cat} package order has been submitted. Waiting for payment confirmation.`,
        time: timeAgo(order.createdAt),
        orderId: order.id,
        createdAt: order.createdAt,
        read: false,
      });

      // ── Add status-specific event if the order progressed
      if (order.status === 'CONFIRMED' && order.confirmedAt) {
        notifications.push({
          id: `confirmed-${order.id}`,
          type: 'order_confirmed',
          title: `Order ${sid} Confirmed`,
          desc: `Payment verified! Your ${cat} videos are being prepared for delivery.`,
          time: timeAgo(order.confirmedAt),
          orderId: order.id,
          createdAt: order.confirmedAt,
          read: false,
        });
      }

      if (order.status === 'DELIVERING') {
        const deliveryDate = order.confirmedAt ?? order.updatedAt;
        notifications.push({
          id: `delivering-${order.id}`,
          type: 'order_delivering',
          title: `Order ${sid} In Delivery`,
          desc: `Your ${cat} videos are being sent to you via Telegram right now!`,
          time: timeAgo(deliveryDate),
          orderId: order.id,
          createdAt: deliveryDate,
          read: false,
        });
      }

      if (order.status === 'COMPLETED' && order.completedAt) {
        notifications.push({
          id: `completed-${order.id}`,
          type: 'order_completed',
          title: `Order ${sid} Completed! 🎉`,
          desc: `All ${order.videoCount} ${cat} videos have been delivered. Enjoy!`,
          time: timeAgo(order.completedAt),
          orderId: order.id,
          createdAt: order.completedAt,
          read: false,
        });
      }

      if (order.status === 'REJECTED') {
        notifications.push({
          id: `rejected-${order.id}`,
          type: 'order_rejected',
          title: `Order ${sid} Rejected`,
          desc: `Your ${cat} order could not be confirmed. Please contact support.`,
          time: timeAgo(order.updatedAt),
          orderId: order.id,
          createdAt: order.updatedAt,
          read: false,
        });
      }
    }

    // Sort by date, newest first
    notifications.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Return latest 20
    res.json({ success: true, data: notifications.slice(0, 20) });
  } catch (error) {
    console.error('[getNotifications]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
