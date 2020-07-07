const path = require('path');
const execa = require('execa');
const waitOn = require('wait-on');
const { cleanTestApp, startTestApp } = require('./helpers/testAppGenerator');
const { startFirestore } = require('./helpers/firestore');

const appName = '.';

const test = async () => {
  return execa('npm', ['run', 'test:e2e'], {
    stdio: 'inherit',
    cwd: path.resolve(appName),
  });
};

const main = async () => {
  let firestoreProcess;
  let testAppProcess;
  let err;

  try {
    await cleanTestApp(appName);

    firestoreProcess = startFirestore();
    await Promise.race([firestoreProcess, waitOn({ resources: ['http-get://localhost:8080'], timeout: 15_000, })]);

    testAppProcess = startTestApp({ appName });
    await Promise.race([testAppProcess, waitOn({ resources: ['http://localhost:1337'], timeout: 30_000, })]);

    await test();

  } catch (error) {
    console.log(error);
    err = true;
  } finally {
    if (firestoreProcess) {
      try {
        console.log('Killing Firestore...');
        firestoreProcess.kill('SIGINT', { forceKillAfterTimeout: 5000 });
        await firestoreProcess;
      } catch {
      }
    }
    if (testAppProcess) {
      try {
        console.log('Killing Strapi...');
        testAppProcess.kill('SIGINT', { forceKillAfterTimeout: 5000 });
        await testAppProcess;
      } catch {
      }
    }
  }

  if (err) {
    process.stdout.write('Tests failed\n', () => {
      process.exit(1);
    });
  } else {
    process.exit(0);
  }
};

main();
