'use-strict';

const { loadCoverage, remap, writeReport } = require('remap-istanbul');

/**
 * Remaps the source coverage to the original TypeScript source.
 */
module.exports = async () => {

  // Remap coverage
  // The implementation only sorts out the relative paths correctly if
  // the working directory is the root directory
  const cwd = process.cwd();
  try {
    process.chdir('../');
    const coverage = await loadCoverage('coverage/coverage-final.json');
    const remapped = await remap(coverage);
    await writeReport(remapped, 'json', {}, 'coverage/coverage.json');
  } finally {
    process.chdir(cwd);
  }
};
