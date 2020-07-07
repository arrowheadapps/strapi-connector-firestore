module.exports = {
  name: 'API integration tests',
  testMatch: ['<rootDir>/test/node_modules/strapi/**/?(*.)+(spec|test).e2e.js'],
  testEnvironment: 'node',
  testPathIgnorePatterns: [],
  coveragePathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/lib/',
    '<rootDir>/test/',
  ],
  transform: {},
};
