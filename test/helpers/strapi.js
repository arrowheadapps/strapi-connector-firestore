const execa = require('execa');
const request = require('request-promise-native');
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
      stdio: process.env.SILENT ? ['pipe', 'pipe', 'inherit'] : ['pipe', 'inherit', 'inherit'],
      env: {
        BROWSER: 'none',
        STRAPI_HIDE_STARTUP_MESSAGE: 'true',
      },
    });

    strapiProc.finally(() => {
      strapiProc = null;
      log('Strapi stopped!\n');
    });

  } else {
    log('Strapi already started.\n');
  }

  await waitForStrapi();
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

async function waitForStrapi() {
  const ping = async () => {
    return new Promise((resolve, reject) => {
      // ping _health
      request({
        url: 'http://localhost:1337/_health',
        method: 'HEAD',
        mode: 'no-cors',
        json: true,
        headers: {
          'Content-Type': 'application/json',
          'Keep-Alive': false,
        },
      }).then(resolve, reject);
    }).catch(() => {
      return new Promise(resolve => setTimeout(resolve, 200)).then(ping);
    });
  };
  
  // Wait for Strapi to come online
  log('Waiting for Strapi to come online... ');
  await new Promise(resolve => setTimeout(resolve, 200)).then(ping);
  log('Strapi online!\n');
}

module.exports = { 
  startStrapi,
  reloadStrapi,
  stopStrapi,
  waitForStrapi,
};
