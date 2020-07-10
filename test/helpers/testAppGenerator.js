const path = require('path');
const rimraf = require('rimraf');
const fs = require('fs-extra');
const { promisify } = require('util');

const rm = promisify(rimraf);

const testsDir = '__tests__';

/**
 * Delete the testApp folder
 * @param {string} appName - name of the app / folder where the app is located
 */
const cleanTestApp = async appName => {
  await Promise.all([
    rm(path.resolve(appName, '.cache')),
    rm(path.resolve(appName, '.temp')),
    rm(path.resolve(appName, 'public')),
    rm(path.resolve(appName, 'build')),
    rm(path.resolve(appName, 'api')),
    rm(path.resolve(appName, 'extensions')),
    rm(path.resolve(appName, 'components')),
  ]);

  await fs.mkdir('api');
  await fs.mkdir('extensions');
};

const cleanTests = async appName => {
  await rm(path.resolve(appName, testsDir));
};

const copyTests = async appName => {
  const strapiDir = path.dirname(require.resolve('strapi/package.json'));
  const rootDir = path.resolve(appName);
  const dest = path.join(rootDir, testsDir);

  await fs.emptyDir(dest);
  await fs.copy(path.join(strapiDir, testsDir), dest);
};

module.exports = {
  cleanTestApp,
  copyTests,
  cleanTests
};
