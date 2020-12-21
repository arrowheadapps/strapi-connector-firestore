const { stopFirestore } = require('./helpers/firestore');
const { stopStrapi } = require('./helpers/strapi');

module.exports = async () => {
  await Promise.all([
    stopFirestore(),
    stopStrapi(),
  ]);
};
