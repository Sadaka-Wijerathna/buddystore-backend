import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import webpush from '../lib/webpush';

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

type NotificationType = 'order_placed' | 'order_confirmed' | 'order_delivering' | 'order_completed' | 'order_rejected' | 'wallet_bonus' | 'new_trending' | 'new_pdf' | 'profile_update' | 'system';

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

    // 1. Fetch legacy orders dynamically
    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
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
        read: false, // Legacy fallback, handled by frontend local storage mostly
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

    // 2. Fetch new persistent notifications from DB
    // (Both user-specific AND global broadcasts)
    const dbNotifications = await prisma.notification.findMany({
      where: {
        OR: [
          { userId: userId },
          { userId: null } // Global broadcasts
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    for (const dbNotif of dbNotifications) {
      notifications.push({
        id: dbNotif.id,
        type: dbNotif.type as NotificationType,
        title: dbNotif.title,
        desc: dbNotif.desc,
        time: timeAgo(dbNotif.createdAt),
        orderId: '', // not order specific
        createdAt: dbNotif.createdAt,
        // If it's a global notification, we check if this user's ID is in readIds
        // If it's specifically for this user, we don't strictly need to track it via readIds array unless we want true backend read sync. Frontend handles read states mainly.
        read: dbNotif.readIds.includes(userId),
      });
    }

    // Sort by date, newest first
    notifications.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Return latest 30 mixed notifications
    res.json({ success: true, data: notifications.slice(0, 30) });
  } catch (error) {
    console.error('[getNotifications]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── PUSH NOTIFICATIONS ─────────────────────────────────────────────────────────

export const subscribeToPush = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { endpoint, keys } = req.body;
    
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
       res.status(400).json({ success: false, message: 'Invalid subscription object' });
       return;
    }

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId, p256dh: keys.p256dh, auth: keys.auth },
      create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[subscribeToPush]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const unsubscribeFromPush = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
       res.status(400).json({ success: false, message: 'Missing endpoint' });
       return;
    }

    await prisma.pushSubscription.deleteMany({
      where: { endpoint, userId: req.user!.id }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[unsubscribeFromPush]', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── UNIFIED DISPATCHER ─────────────────────────────────────────────────────────

export async function dispatchNotification(
  userId: string | null,
  type: string,
  title: string,
  desc: string
) {
  // 1. Create the persistent database record for the UI drop-down
  const notification = await prisma.notification.create({
    data: { userId, type, title, desc }
  });

  // 2. Fetch push subscriptions from the DB
  let subscriptions;
  if (userId) {
    subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  } else {
    // Global broadcast
    subscriptions = await prisma.pushSubscription.findMany();
  }

  // 3. Fire Web Push (Fire and Forget)
  if (subscriptions.length > 0) {
    const payload = JSON.stringify({ title, desc, url: '/dashboard', type });

    Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth }
            },
            payload
          );
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription has expired or is no longer valid, clean up DB
            await prisma.pushSubscription.delete({ where: { id: sub.id } });
          }
        }
      })
    ).catch(e => console.error('[dispatchNotification web-push error]', e));
  }

  return notification;
}
