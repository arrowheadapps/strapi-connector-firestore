const { stopFirestore } = require('./helpers/firestore');

module.exports = async () => {
  await stopFirestore();
};
