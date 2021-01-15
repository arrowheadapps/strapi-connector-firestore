const { startFirestore } = require('./utils/firestore');

module.exports = async () => {
  await startFirestore();
};
