import webpush from 'web-push';
import dotenv from 'dotenv';

dotenv.config();

const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
  console.error('[WebPush] Missing VAPID keys. Web Push is unavailable.');
} else {
  webpush.setVapidDetails(
    'mailto:support@buddystore.lk',
    publicVapidKey,
    privateVapidKey
  );
}

export default webpush;
