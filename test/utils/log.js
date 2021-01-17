'use-strict';

/**
 * Writes to `process.stdout` only if the env configuration
 * is set to verbose.
 * @param  {...any} params 
 */
const log = (...params) => {
  if (!process.env.SILENT) {
    process.stdout.write(...params);
  }
};

module.exports = {
  log,
};
