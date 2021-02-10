'use-strict';

const path = require('path');
const fs = require('fs-extra');
const degit = require('degit');


const testsDir = 'tests';
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
  // Determine installed Strapi version
  const { version } = require('strapi/package.json');

  // Download the tests from GitHub
  await fs.emptyDir(testsDir);
  await degit(`strapi/strapi/packages/strapi/${testsDir}`).clone(testsDir)

  // Remove excluded tests
  console.log(`Collection flattening: "${process.env.FLATTENING || 'flatten_none'}"`)
  const excludes = flattenExcludes[process.env.FLATTENING] || [];
  for (const p of await fs.readdir(testsDir)) {
    if (excludes.some(e => e.test(p))) {
      await fs.remove(path.join(testsDir, p));
    }
  }
};

const setupTestApp = async () => {
  await cleanTestApp();
  await copyTests();

  // Clean coverage outputs
  // Jest seems to fail to write the JSON results otherwise
  await Promise.all([
    fs.emptyDir(path.resolve('../coverage')),
  ]);
};


module.exports = {
  cleanTestApp,
  copyTests,
  cleanTests,
  setupTestApp,
};
