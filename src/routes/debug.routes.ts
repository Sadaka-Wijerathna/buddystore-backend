import { Router } from 'express';
import config from '../config';

const router = Router();

router.get('/debug-env', (req, res) => {
  res.json({
    success: true,
    message: 'Environment diagnostics',
    data: {
      shouldStartBots: config.shouldStartBots,
      webhookBaseUrl: config.webhookBaseUrl ? 'SET' : 'MISSING',
      botSpecialToken: config.bots.special ? 'SET' : 'MISSING',
      mainBotToken: config.bots.main ? 'SET' : 'MISSING',
      nodeEnv: config.nodeEnv,
    }
  });
});

export default router;
