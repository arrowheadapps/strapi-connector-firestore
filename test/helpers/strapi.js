const execa = require('execa');
const waitOn = require('wait-on');
const { log } = require('./log');

/**
 * @type {execa.ExecaChildProcess | null}
 */
let strapiProc = null;

/**
 * Starts Strapi if not already started, and returns
 * a promise that resolves when the Strapi server is available.
 */
async function startStrapi() {

  if (!strapiProc) {
    log('Starting Strapi... ');
    strapiProc = execa.command('nyc --silent --no-clean strapi start', { 
      preferLocal: true,
      cleanup: true,
      reject: false,
      stdio: 'pipe',
      env: {
        BROWSER: 'none',
        STRAPI_HIDE_STARTUP_MESSAGE: 'true',
      },
    });

    // Pipe Strapi output to the parent
    strapiProc.stderr.pipe(process.stderr);
    if (!process.env.SILENT) {
      strapiProc.stdout.pipe(process.stdout);
    }

    strapiProc.finally(() => {
      strapiProc = null;
      log('Strapi stopped!\n');
    });

  } else {
    log('Strapi already started.\n');
  }

  // Wait for Strapi to become available
  // or throw error if Strapi exits before becoming available
  await Promise.race([
    waitForStrapi(),
    strapiProc.then(() => Promise.reject(new Error('Strapi failed to start!'))),
  ]);
}

/**
 * Stops Strapi if it is running, then starts it again.
 * Returns a promise that resolves when the server is available.
 */
async function reloadStrapi() {
  await stopStrapi();
  await startStrapi();
}


async function stopStrapi() {
  if (strapiProc) {
    log('Stopping Strapi... ');
    strapiProc.kill();
    // strapiProc.send('stop');
    await strapiProc;

    // Wait for the next event loop so that the cleanup
    // of the strapiProc will have completed
    await new Promise(resolve => setImmediate(resolve));
  } else {
    log('Strapi already stopped.\n');
  }
}

async function waitForStrapi(timeoutMs = 30_000) {
  log('Waiting for Strapi to come online... ');
  try {
    await waitOn({
      resources: ['http://localhost:1337/_health'],
      headers: {
        'Content-Type': 'application/json',
        'Keep-Alive': false,
      },
      window: 0,
      timeout: timeoutMs,
    });
  } catch {
    throw new Error('Timeout waiting for Strapi to come online');
  }

  log('Strapi online!\n');
}

module.exports = { 
  startStrapi,
  reloadStrapi,
  stopStrapi,
  waitForStrapi,
};
