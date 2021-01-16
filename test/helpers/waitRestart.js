'use strict';

const { reloadStrapi } = require('./strapi');

module.exports = async function (initTime = 200) {
  await new Promise(resolve => setTimeout(resolve, initTime));
  await reloadStrapi();
};
