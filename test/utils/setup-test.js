'user-strict';

const { startFirestore, stopFirestore } = require('./firestore');
const { cleanTestApp } = require('./app');

let firestore = null;

beforeAll(async () => {
  await cleanTestApp();
  firestore = await startFirestore();
});

afterAll(async () => {
  await stopFirestore(firestore);
  firestore = null;
});


// From https://github.com/strapi/strapi/blob/be4d5556936cf923aa3e23d5da82a6c60a5a42bc/test/jest2e2.setup.js

const isoDateRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/;

expect.extend({
  stringOrNull(received) {
    const pass = typeof received === 'string' || received === null;
    return {
      message: () => `expected ${received} ${pass ? 'not ' : ''}to be null or a string`,
      pass,
    };
  },
  toBeISODate(received) {
    const pass = isoDateRegex.test(received) && new Date(received).toISOString() === received;
    return {
      pass,
      message: () => `Expected ${received} ${pass ? 'not ' : ''}to be a valid ISO date string`,
    };
  },
});
