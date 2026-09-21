/**
 * Helper to generate signed JWT tokens for test requests.
 * Mirrors the payload shape used by auth.controller.ts.
 */
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough';

export interface TokenPayload {
  id: string;
  role: 'USER' | 'ADMIN';
  adminRole?: string | null;
  telegramUsername: string;
  tokenVersion?: number;
}

export function makeToken(payload: TokenPayload, expiresIn = '1h'): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

// ─── Preset tokens ────────────────────────────────────────────────────────────

export const USER_ID   = 'user-test-uuid-1234';
export const ADMIN_ID  = 'admin-test-uuid-5678';

export const userToken = () =>
  makeToken({ id: USER_ID, role: 'USER', telegramUsername: 'testuser', tokenVersion: 0 });

export const adminToken = () =>
  makeToken({ id: ADMIN_ID, role: 'ADMIN', adminRole: 'SUPER_ADMIN', telegramUsername: 'testadmin', tokenVersion: 0 });

export const expiredToken = () =>
  makeToken({ id: USER_ID, role: 'USER', telegramUsername: 'testuser' }, '-1s');

// ─── Fake DB user rows (returned by prisma.user.findUnique mocks) ─────────────

export const fakeUser = {
  id: USER_ID,
  telegramId: BigInt(111111111),
  telegramUsername: 'testuser',
  firstName: 'Test',
  lastName: null,
  passwordHash: '$2b$10$hashedpassword',
  role: 'USER',
  adminRole: null,
  isBanned: false,
  bannedAt: null,
  tokenVersion: 0,
  walletBalance: 0,
  referralCode: 'TESTREF',
  referredById: null,
  hasStartedBot: true,
  isBot: false,
  languageCode: 'en',
  photoUrl: null,
  lastIpAddress: null,
  deviceType: null,
  lastLoginAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  oldTelegramUsername: null,
  usernameUpdatedAt: null,
};

export const fakeAdmin = {
  ...fakeUser,
  id: ADMIN_ID,
  telegramUsername: 'testadmin',
  role: 'ADMIN',
  adminRole: 'SUPER_ADMIN',
  tokenVersion: 0,
};

export const fakeBannedUser = {
  ...fakeUser,
  isBanned: true,
  bannedAt: new Date(),
};
