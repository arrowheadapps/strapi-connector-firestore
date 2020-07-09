const { startStrapi, stopStrapi } = require('./helpers/strapi');

beforeAll(async done => {
  await startStrapi();
  done();
}, 60_000);


afterAll(async done => {
  await stopStrapi();
  done();
}, 60_000);