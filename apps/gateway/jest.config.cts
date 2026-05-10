module.exports = {
  displayName: '@org/gateway',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  coverageDirectory: 'test-output/jest/coverage',
  moduleNameMapper: {
    // Generated Prisma 7 client uses ESM (`import.meta.url`); ts-jest's
    // CommonJS transform can't compile it. Tests don't need the real one.
    '^.*generated/prisma/client$': '<rootDir>/test/prisma-client.mock.ts',
  },
};
