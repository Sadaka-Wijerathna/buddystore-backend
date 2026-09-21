/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
  testTimeout: 30000,
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
      },
    }],
  },
  moduleNameMapper: {
    // Redirect all prisma imports to the shared mock
    '^../lib/prisma$': '<rootDir>/src/__tests__/__mocks__/prisma.ts',
    '^../../lib/prisma$': '<rootDir>/src/__tests__/__mocks__/prisma.ts',
    '^../../../lib/prisma$': '<rootDir>/src/__tests__/__mocks__/prisma.ts',
    // Silence socket.io in tests
    '^../lib/socket$': '<rootDir>/src/__tests__/__mocks__/socket.ts',
    '^../../lib/socket$': '<rootDir>/src/__tests__/__mocks__/socket.ts',
    // Silence cloudinary in tests
    '^../lib/cloudinary$': '<rootDir>/src/__tests__/__mocks__/cloudinary.ts',
    '^../../lib/cloudinary$': '<rootDir>/src/__tests__/__mocks__/cloudinary.ts',
  },
};
