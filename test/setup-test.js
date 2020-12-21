const { startStrapi, stopStrapi } = require('./helpers/strapi');
const { cleanTestApp } = require('./helpers/app');
const { purgeFirestore } = require('./helpers/firestore');

beforeAll(async done => {
  await startStrapi();
  done();
}, 60_000);

afterAll(async done => {
  await Promise.all([
    purgeFirestore(),
    stopStrapi().then(() => cleanTestApp()),
  ]);
  done();
}, 60_000);
