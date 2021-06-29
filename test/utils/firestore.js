'use-strict';

const { FirestoreEmulator  } = require('firebase-tools/lib/emulator/firestoreEmulator');


const startFirestore = async () => {
  const firestore = new FirestoreEmulator({
    host: '127.0.0.1',
    port: '8080',
    projectId: 'test-project-id',
  });
  const stop = async () => {
    process.stdout.write('Stopping Firestore because process is exiting....');
    await firestore.stop();
    process.exit();
  };
  
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGABRT', stop);
  process.once('beforeExit', stop);

  try {
    await firestore.start();
    process.stdout.write('Firestore online.\r\n');
    return firestore;
  } catch (err) {
    process.stdout.write('Firestore failed to start.\r\n');
    console.error(err);
    throw err;
  }
};

/**
 * 
 * @param {FirestoreEmulator} firestore 
 */
const stopFirestore = async (firestore) => {
  try {
    await firestore.stop();
    process.stdout.write('Firestore stopped.\r\n');
  } catch (err) {
    process.stdout.write('Firestore failed to stop.\r\n');
    console.error(err);
    throw err;
  }
};

module.exports = {
  startFirestore,
  stopFirestore,
};
