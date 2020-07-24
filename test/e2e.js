const path = require('path');
const execa = require('execa');
const { cleanTestApp, copyTests } = require('./helpers/testAppGenerator');
const { stopStrapi } = require('./helpers/strapi');

const test = async () => {
  return execa('npm', ['run', '-s', 'test:e2e'], {
    stdio: 'inherit',
  });
};

const main = async () => {

  try {
    // Clean the app
    await cleanTestApp();

    // Required because Jest seemingly refuses to run 
    // tests located underneath node_modules
    await copyTests();

    await test();

  } catch (error) {
    console.log(error.shortMessage || error);
    console.log('\nTests failed\n');
    process.exitCode = 1;
  }

  // Stop Strapi
  try {
    await stopStrapi();
  } catch {
  }

  // Clean again on completion
  try {
    await cleanTestApp();
  } catch {
  }
};

main();
