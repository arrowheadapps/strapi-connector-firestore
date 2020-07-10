const { startStrapi } = require('./helpers/strapi');

beforeAll(async done => {
  await startStrapi();
  done();
}, 60_000);


// Now we stop Strapi in the deleteContentType(s) functions
// So that we don't end up restarting several times at the end
// only to stop again

// afterAll(async done => {
//   await stopStrapi();
//   done();
// }, 60_000);
