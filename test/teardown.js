'use-strict';

const { loadCoverage, remap, writeReport } = require('remap-istanbul');

/**
 * Remaps the source coverage to the original TypeScript source.
 */
module.exports = async () => {

  // Remap coverage
  process.chdir('../');
  const coverage = await loadCoverage('coverage/coverage-final.json');
  const remapped = await remap(coverage);
  await writeReport(remapped, 'json', {}, 'coverage/coverage.json');
};
