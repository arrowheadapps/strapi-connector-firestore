'use-strict';

const { loadCoverage, remap, writeReport } = require('remap-istanbul');
const { teardownTestApp } = require('./utils/app');
const path = require('path')

/**
 * Remaps the source coverage to the original TypeScript source,
 * cleans the test app directory.
 */
module.exports = async () => {

  // Remap coverage
  const basePath = path.resolve('../');
  const coverage = await loadCoverage(path.join(basePath, 'coverage-final.json'));
  const remapped = await remap(coverage, { basePath });
  await writeReport(remapped, 'json', {}, path.join(basePath, 'coverage.json'));

  await teardownTestApp();
};
