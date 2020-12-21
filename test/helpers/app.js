const path = require('path');
const fs = require('fs-extra');


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
    fs.remove('.cache'),
    fs.remove('.temp'),
    fs.remove('public'),
    fs.remove('build'),
    fs.remove('components'),
    fs.emptyDir('api'),
    fs.emptyDir('extensions'),
  ]);
};

/**
 * Removes the Strapi tests.
 */
const cleanTests = async () => {
  await fs.remove(path.resolve(testsDir));
};

/**
 * Jest seemingly refuses to run tests located under `node_modules`,
 * so we copy Strapi's tests out into our test dir.
 */
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

const setupTestApp = async () => {
  await cleanTestApp();
  await copyTests();

  // Ensure the output directory exists
  // Jest seems to fail to write the JSON results otherwise
  await fs.ensureDir(path.resolve('../coverage'));
};

const teardownTestApp = async () => {
  await Promise.all([
    cleanTestApp(),
    cleanTests(),
  ]);
};


module.exports = {
  cleanTestApp,
  copyTests,
  cleanTests,
  setupTestApp,
  teardownTestApp,
};
