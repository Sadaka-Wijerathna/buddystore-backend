// Shared Prisma mock — used by all test files via moduleNameMapper.
// jest-mock-extended creates a full DeepMockProxy of the PrismaClient.

import { PrismaClient } from '@prisma/client';
import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';

const prisma = mockDeep<PrismaClient>();

export type MockPrisma = DeepMockProxy<PrismaClient>;

// Auto-reset all mocks before every test
beforeEach(() => {
  mockReset(prisma);
});

export default prisma;
