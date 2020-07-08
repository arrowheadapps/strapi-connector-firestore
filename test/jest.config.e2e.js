module.exports = {
  name: 'API integration tests',
  rootDir: '../',
  collectCoverage: true,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/?(*.)+(spec|test).e2e.js'],

  collectCoverageFrom: [
    // FIXME:
    // Collect coverage from the compiled source in the installed module
    // Currently the coverage is not collected because the connector code 
    // is run by Strapi in a separate process from Jest
    '<rootDir>/lib/**/*.js'
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
