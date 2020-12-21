module.exports = {
  name: 'API integration tests',
  collectCoverage: true,
  testEnvironment: 'node',
  verbose: !process.env.SILENT,
  testMatch: ['**/*.test*.js'],
  globalSetup: 'setup.js',
  globalTeardown: 'teardown.js',
  setupFilesAfterEnv: ['setup-test.js'],

  collectCoverage: true,
  coverageReporters: ['json', 'text'],
  collectCoverageFrom: [
    '../lib/**/*.js',
  ],
  moduleNameMapper: {
    // When tests are copied over from the strapi module
    // the relative imports are broken
    // So map them to the correct place
    '\\.\\.\\/test\\/helpers\/(.*)$': '<rootDir>/helpers/$1',
  },
  transform: {},
};
