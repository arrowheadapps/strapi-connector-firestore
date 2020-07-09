const { startFirestore } = require('./helpers/firestore');

module.exports = async () => {
  await startFirestore();
};
