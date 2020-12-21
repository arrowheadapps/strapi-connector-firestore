module.exports = {
  name: 'API integration tests',
  testEnvironment: 'node',
  verbose: !process.env.SILENT,
  testMatch: ['<rootDir>/**/*.test*.js'],
  globalSetup: '<rootDir>/setup.js',
  globalTeardown: '<rootDir>/teardown.js',
  setupFilesAfterEnv: ['<rootDir>/setup-test.js'],

  collectCoverage: true,
  coverageReporters: ['json', 'text'],
  coverageDirectory: '<rootDir>/../coverage',
  collectCoverageFrom: [
    '**/strapi-connector-firestore/lib/**',
  ],

  moduleNameMapper: {
    // Tests are copied from the Strapi module so the relative imports are broken
    // So map them to the correct place
    '\\.\\.\\/test\\/helpers\/(.*)$': '<rootDir>/helpers/$1',
  },

  transform: {

  },
};
