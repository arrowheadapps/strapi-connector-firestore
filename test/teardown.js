const { stopFirestore } = require('./helpers/firestore');
const codecov = require('codecov');

module.exports = async () => {
  await stopFirestore();
};
