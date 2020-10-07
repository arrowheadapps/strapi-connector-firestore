module.exports = {
  name: 'API integration tests',
  rootDir: '../',
  collectCoverage: true,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.e2e.js'],
  globalSetup: '<rootDir>/test/setup.js',
  globalTeardown: '<rootDir>/test/teardown.js',
  setupFilesAfterEnv: ['<rootDir>/test/setup-test.js'],

  coverageReporters: ['json', 'text'],
  collectCoverageFrom: [
    '<rootDir>/lib/**/*.js',
  ],
  moduleNameMapper: {
    // When tests are copied over from the strapi module
    // the relative imports are broken
    // So map them to the correct place
    '^\\.\\./\\.\\./\\.\\./test/(.*)': '<rootDir>/test/$1',
    '^\\.\\./\\.\\./\\.\\./\\.\\./test/(.*)': '<rootDir>/test/$1',
  },
  transform: {},
};
