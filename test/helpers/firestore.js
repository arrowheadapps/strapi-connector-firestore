const execa = require('execa');

const startFirestore = () => {
  return execa('node_modules/.bin/firebase emulators:start --only firestore', {
    stdio: 'inherit',
    shell: true,
  });
};

module.exports = {
  startFirestore
};
