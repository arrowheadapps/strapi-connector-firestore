module.exports = {
  name: 'API integration tests',
  testEnvironment: 'node',
  verbose: !process.env.SILENT,
  collectCoverage: false,
  transform: { },

  testMatch: ['<rootDir>/**/*.test*.js'],
  globalSetup: '<rootDir>/setup.js',
  globalTeardown: '<rootDir>/teardown.js',
  setupFilesAfterEnv: ['<rootDir>/setup-test.js'],

  moduleNameMapper: {
    // Tests are copied from the Strapi module so the relative imports are broken
    // So map them to the correct place
    '\\.\\./test/helpers/(.*)$': '<rootDir>/helpers/$1',
  },
};
