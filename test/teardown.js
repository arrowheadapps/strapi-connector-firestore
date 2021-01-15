const { stopFirestore } = require('./utils/firestore');

module.exports = async () => {
  await stopFirestore();
};
