module.exports = {
  name: 'API integration tests',
  rootDir: '../',
  testEnvironment: 'node',
  verbose: true,
  transform: { },
  testMatch: ['<rootDir>/test/**/*.test*.js'],
  setupFilesAfterEnv: ['<rootDir>/test/utils/setup-test.js'],
  globalTeardown: '<rootDir>/test/teardown.js',

  collectCoverage: true,
  coverageReporters: ['json', 'text-summary'],
  collectCoverageFrom: [
    '<rootDir>/lib/**/*.js',
  ],

  moduleNameMapper: {
    // Tests are copied from the Strapi module so the relative imports are broken
    // So map them to the correct place
    '\\.\\./test/helpers/(.*)$': '<rootDir>/test/helpers/$1',
  },
};
