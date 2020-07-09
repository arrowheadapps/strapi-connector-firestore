module.exports = {
  name: 'API integration tests',
  rootDir: '../',
  collectCoverage: true,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/?(*.)+(spec|test).e2e.js'],
  globalSetup: '<rootDir>/test/setup.js',
  globalTeardown: '<rootDir>/test/teardown.js',
  setupFilesAfterEnv: ['<rootDir>/test/setup-test.js'],

  collectCoverageFrom: [
    '<rootDir>/lib/**/*.js',
  ],
  coveragePathIgnorePatterns: [],
  moduleNameMapper: {
    // When tests are copied over from the strapi module
    // the relative imports are broken
    // So map them to the correct place
    '^\\.\\./\\.\\./\\.\\./test/(.*)': '<rootDir>/test/$1'
  },
  transform: {},
};
