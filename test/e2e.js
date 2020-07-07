const path = require('path');
const { cleanTestApp, generateTestApp, startTestApp } = require('./helpers/testAppGenerator');
const execa = require('execa');
const waitOn = require('wait-on');

const appName = 'testApp';

const databases = {
  firestore: {
    projectId: true,
    useEmulator: true,
  },
};

const test = async args => {
  return execa('npm', ['-s', 'test:e2e', ...args.split(' ')], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
    env: {
      FORCE_COLOR: 1,
    },
  });
};

const main = async (database, args) => {
  try {
    await cleanTestApp(appName);
    await generateTestApp({ appName, database });
    const testAppProcess = startTestApp({ appName });

    await waitOn({ resources: ['http://localhost:1337'] });

    await test(args).catch(() => {
      testAppProcess.kill();
      process.stdout.write('Tests failed\n', () => {
        process.exit(1);
      });
    });

    testAppProcess.kill();
    process.exit(0);
  } catch (error) {
    console.log(error);
    process.stdout.write('Tests failed\n', () => {
      process.exit(1);
    });
  }
};

main(databases.firestore, '');
