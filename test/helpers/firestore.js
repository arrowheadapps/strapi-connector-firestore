const execa = require('execa');
const waitOn = require('wait-on');

let proc;

const startFirestore = async () => {
  if (proc) {
    return;
  }

  try {
    process.stdout.write('\nStarting Firestore...\n');
    proc = execa('node_modules/.bin/firebase emulators:start --only firestore', {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: true,
    });

    // Wait for Firestore to come online or for the process to end or crash
    const result = await Promise.race([
      proc, 
      waitOn({ resources: ['http-get://localhost:8080'], timeout: 15_000, })
    ]);

    if (result) {
      // If the result is truthy
      // it means that it was the firestore process that completed
      // not the waitOn() promise (which returns undefined)
      throw new Error(result.shortMessage);
    }

    process.stdout.write('Firestore started!\n');

  } catch (err) {
    process.stdout.write(`Failed to start Firestore! ${err && err.message}\n`);
    throw err;
  }
};

const stopFirestore = async () => {
  if (proc) {
    try {
      process.stdout.write('Killing Firestore...\n');
      proc.kill('SIGINT', { forceKillAfterTimeout: 3000 });

      // Wait for process to end or timeout
      await Promise.race([
        proc,
        new Promise((_, reject) => setTimeout(reject, 5000)),
      ]);
    } catch {
      process.stdout.write('Failed to kill Firestore!\n');
    }
  }
};

module.exports = {
  startFirestore,
  stopFirestore
};
