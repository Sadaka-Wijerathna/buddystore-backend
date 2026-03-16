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

  redis: {
    url: process.env.REDIS_URL || '',
  },

  uploadDir: process.env.UPLOAD_DIR || 'uploads',

  bots: {
    main: process.env.MAIN_BOT_TOKEN || '',
    mixed: process.env.BOT_MIXED_TOKEN || '',
    momSon: process.env.BOT_MOM_SON_TOKEN || '',
    sriLankan: process.env.BOT_SRI_LANKAN_TOKEN || '',
    cctv: process.env.BOT_CCTV_TOKEN || '',
    public: process.env.BOT_PUBLIC_TOKEN || '',
    rape: process.env.BOT_RAPE_TOKEN || '',
    special: process.env.BOT_SPECIAL_TOKEN || '',
  },
};

export default config;
