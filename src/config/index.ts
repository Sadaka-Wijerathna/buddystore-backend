import dotenv from 'dotenv';
dotenv.config();

const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  jwt: {
    secret: process.env.JWT_SECRET || 'fallback_secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  uploadDir: process.env.UPLOAD_DIR || 'uploads',

  bots: {
    main: process.env.MAIN_BOT_TOKEN || '',
    special: process.env.BOT_SPECIAL_TOKEN || '',
  },
  telegram: {
    publicChannelId: process.env.PUBLIC_CHANNEL_ID || '', // Used for broadcasting 5-star reviews
    apiId: process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : undefined,
    apiHash: process.env.TELEGRAM_API_HASH || '',
  },
  shouldStartBots: process.env.SHOULD_START_BOTS !== 'false',

  // ─── Webhook config (production) ─────────────────────────────────────────
  // WEBHOOK_BASE_URL: the public HTTPS root of this service, e.g. https://buddystore-backend.onrender.com
  // WEBHOOK_SECRET:   random string registered with Telegram so only real Telegram requests are accepted
  webhookBaseUrl: (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, ''), // strip trailing slash
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // ─── Telegram Stars CONFIG ────────────────────────────────────────────────
  // 1 Star is approx 5.5 LKR to cover the 30% fee and withdrawal costs
  stars: {
    rateLkr: 5.5,
    commissionOffset: 1.43, // Multiplier to ensure you get full LKR after 30% fee
  }
};

export default config;
