module.exports = {
  name: 'API integration tests',
  testEnvironment: 'node',
  verbose: !process.env.SILENT,

  // Required so that we can collect coverage from the root directory
  rootDir: '../',
  
  collectCoverage: true,
  coverageReporters: ['json', 'text'],
  coverageDirectory: '<rootDir>/coverage',
  collectCoverageFrom: [
    '**/*.{ts,js}',
    '!**/node_modules/**',
    '!**/test/**',
    '!**/examples/**',
  ],

  testMatch: ['<rootDir>/test/**/*.test*.js'],
  globalSetup: '<rootDir>/test/setup.js',
  globalTeardown: '<rootDir>/test/teardown.js',
  setupFilesAfterEnv: ['<rootDir>/test/setup-test.js'],

  moduleNameMapper: {
    // Tests are copied from the Strapi module so the relative imports are broken
    // So map them to the correct place
    '\\.\\.\\/test\\/helpers\/(.*)$': '<rootDir>/test/helpers/$1',
  },

  transform: {

  },
};
