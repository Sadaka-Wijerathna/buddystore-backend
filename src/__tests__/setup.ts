/**
 * Global test setup — runs before every test file.
 * Sets env vars, mocks grammy bots, mocks Sentry, mocks node-cron.
 */

// ─── Environment ──────────────────────────────────────────────────────────────
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_that_is_long_enough';
process.env.JWT_EXPIRES_IN = '1h';
process.env.MAIN_BOT_TOKEN = 'test:MAIN_BOT_TOKEN';
process.env.BOT_SPECIAL_TOKEN = 'test:SPECIAL_BOT_TOKEN';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
process.env.ENABLE_DOCS = 'false';

// ─── Mock grammy (bot framework) ─────────────────────────────────────────────
// grammy tries to call Telegram API on Bot construction — silence it in tests
jest.mock('grammy', () => {
  const mockBot = {
    api: {
      sendMessage: jest.fn().mockResolvedValue({}),
      sendVideo: jest.fn().mockResolvedValue({}),
      sendPhoto: jest.fn().mockResolvedValue({}),
      sendDocument: jest.fn().mockResolvedValue({}),
      getFile: jest.fn().mockResolvedValue({ file_path: 'test/path' }),
      getChat: jest.fn().mockResolvedValue({ id: 123, type: 'private' }),
      getUserProfilePhotos: jest.fn().mockResolvedValue({ total_count: 0, photos: [] }),
    },
    use: jest.fn(),
    command: jest.fn(),
    on: jest.fn(),
    catch: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
  };
  return {
    Bot: jest.fn().mockImplementation(() => mockBot),
    Context: jest.fn(),
    InlineKeyboard: jest.fn().mockImplementation(() => ({
      url: jest.fn().mockReturnThis(),
      row: jest.fn().mockReturnThis(),
      text: jest.fn().mockReturnThis(),
    })),
    InputFile: jest.fn(),
  };
});

// ─── Mock Sentry ──────────────────────────────────────────────────────────────
jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  setupExpressErrorHandler: jest.fn(),
  captureException: jest.fn(),
}));

// ─── Mock node-cron ──────────────────────────────────────────────────────────
jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

// ─── Mock telegram (MTProto) ─────────────────────────────────────────────────
jest.mock('telegram', () => ({
  TelegramClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isUserAuthorized: jest.fn().mockResolvedValue(false),
  })),
  Api: {},
}));

// ─── Mock web-push ────────────────────────────────────────────────────────────
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
}));

// ─── Mock Upstash Redis ───────────────────────────────────────────────────────
jest.mock('@upstash/redis', () => ({
  Redis: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  })),
}));

// ─── Silence console.log in tests ────────────────────────────────────────────
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
