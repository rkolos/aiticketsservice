module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/config/index.js',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
};

