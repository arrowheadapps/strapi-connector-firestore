const execa = require('execa');
const waitOn = require('wait-on');
const { log } = require('./log');

let proc = null;

/**
 * Starts the Firestore emulator if it isn't started already.
 */
const startFirestore = async () => {
  if (proc) {
    log('Firestore already started!');
    return;
  }

  try {
    log('\nStarting Firestore...\n');
    proc = execa.command('firebase emulators:start --only firestore', {
      preferLocal: true,
      cleanup: true,
      stdio: process.env.SILENT ? 'pipe' : ['pipe', 'inherit', 'inherit'],
    });

    // Wait for Firestore to come online or for the process to end or crash
    const result = await Promise.race([
      proc, 
      waitOn({ resources: ['http-get://localhost:8080'], timeout: 20_000, })
    ]);

    if (result) {
      // If the result is truthy
      // it means that it was the firestore process that completed
      // not the waitOn() promise (which returns undefined)
      throw new Error(result.shortMessage);
    }

    log('Firestore started!\n');

  } catch (err) {
    process.stderr.write(`Failed to start Firestore! ${err && err.message}\n`);
    throw err;
  }
};

const stopFirestore = async () => {
  if (proc) {
    try {
      log('Killing Firestore... ');
      proc.kill('SIGINT', { forceKillAfterTimeout: 3000 });

      // Wait for process to end or timeout
      await Promise.race([
        proc,
        new Promise((_, reject) => setTimeout(reject, 5000)),
      ]);
    } catch {
      process.stderr.write('Failed to kill Firestore!\n');
    }
  }
};

const purgeFirestore = async () => {
  // TODO
};

module.exports = {
  startFirestore,
  stopFirestore,
  purgeFirestore,
};
