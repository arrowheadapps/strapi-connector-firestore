const path = require('path');
const rimraf = require('rimraf');
const fs = require('fs-extra');
const { promisify } = require('util');

const rm = promisify(rimraf);

const testsDir = '__tests__';
const flattenExcludes = {
  flatten_all: [],
  flatten_none: [],

  // For mixed-flattening tests we only need to test relations
  // so skip all the other tests
  flatten_mixed_src: [
    /api/,
    /filtering/,
    /search/,
    /single-type/
  ],
  flatten_mixed_target: [
    /api/,
    /filtering/,
    /search/,
    /single-type/
  ]
};

const cleanTestApp = async () => {
  await Promise.all([
    rm('.cache'),
    rm('.temp'),
    rm('public'),
    rm('build'),
    rm('api'),
    rm('extensions'),
    rm( 'components'),
  ]);

  await fs.mkdir('api');
  await fs.mkdir('extensions');
};

const cleanTests = async () => {
  await rm(path.resolve(testsDir));
};

const copyTests = async () => {
  const strapiDir = path.dirname(require.resolve('strapi/package.json'));
  const rootDir = path.resolve();
  const dest = path.join(rootDir, testsDir);

  await fs.emptyDir(dest);
  await fs.copy(path.join(strapiDir, testsDir), dest);

  // Remove excluded tests
  const excludes = flattenExcludes[process.env.FLATTENING] || [];
  for (const p of await fs.readdir(dest)) {
    if (excludes.some(e => e.test(p))) {
      await fs.remove(path.join(dest, p));
    }
  }
};

module.exports = {
  cleanTestApp,
  copyTests,
  cleanTests
};
