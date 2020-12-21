const execa = require('execa');
const { log } = require('./log');

/**
 * @type {{ proc: execa.ExecaChildProcess, started: Promise<void> } | null}
 */
let firestore = null;

/**
 * Starts the Firestore emulator if it isn't started already.
 */
const startFirestore = async () => {
  if (firestore) {
    log('Firestore already started/starting!');
    return await firestore.started;
  }

  log('\nStarting Firestore...\n');
  const proc = execa.command('firebase emulators:start --only firestore', {
    preferLocal: true,
    cleanup: true,
    stdio: 'pipe',
  });

  // Pipe Firestore output to the parent
  proc.stderr.pipe(process.stderr);
  if (!process.env.SILENT) {
    proc.stdout.pipe(process.stdout);
  }

  proc.finally(() => {
    firestore = null;
    log('Firestore stopped!\n');
  });

  const started = new Promise((resolve, reject) => {
    proc.stdout.on('data', data => {
      if (data.includes('All emulators ready')) {
        resolve();
      }
      if (data.includes('Could not start')) {
        reject(new Error('Firestore failed to start!'));
      }
    });
    proc.once('exit', () => {
      reject(new Error('Firestore failed to start!'));
    });
  });

  firestore = {
    proc,
    started,
  };

  await started;
  log('Firestore started!\n');
};

const stopFirestore = async () => {
  if (firestore) {
    try {
      log('Killing Firestore... ');
      firestore.proc.kill('SIGINT', { forceKillAfterTimeout: 3000 });

      // Wait for process to end or timeout
      await Promise.race([
        firestore.proc,
        new Promise((_, reject) => setTimeout(reject, 5000)),
      ]);

      // Wait for the next event loop so that the firestore
      // variable is set to null by the completion handler
      await new Promise(resolve => setImmediate(resolve));

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
