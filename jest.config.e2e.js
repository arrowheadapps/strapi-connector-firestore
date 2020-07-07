module.exports = {
  name: 'API integration tests',
  testMatch: ['<rootDir>/node_modules/strapi/**/?(*.)+(spec|test).e2e.js'],
  testEnvironment: 'node',
  coveragePathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/lib/',
    '<rootDir>/src/',
    '<rootDir>/test/',
  ],
  transform: {},
};
