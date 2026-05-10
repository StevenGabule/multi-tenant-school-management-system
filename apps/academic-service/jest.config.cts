module.exports = {
  displayName: '@org/academic-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  coverageDirectory: 'test-output/jest/coverage',
  moduleNameMapper: {
    // Generated Prisma 7 client uses ESM (import.meta.url); ts-jest's
    // CommonJS transform can't compile it. Same stub as sis-service uses.
    '^.*generated/prisma/client$': '<rootDir>/test/prisma-client.mock.ts',
  },
};
