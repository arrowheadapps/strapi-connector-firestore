const request = require('request-promise-native');
const { reloadStrapi } = require('./strapi');

module.exports = async function(initTime = 200, triggerRestart = true) {
  const ping = async () => {
    return new Promise((resolve, reject) => {
      // ping _health
      request({
        url: 'http://localhost:1337/_health',
        method: 'HEAD',
        mode: 'no-cors',
        json: true,
        headers: {
          'Content-Type': 'application/json',
          'Keep-Alive': false,
        },
      }).then(resolve, reject);
    }).catch(() => {
      return new Promise(resolve => setTimeout(resolve, 200)).then(ping);
    });
  };

  if (triggerRestart) {
    // Trigger reload
    await reloadStrapi();
  }

  // Wait for Strapi to come back online
  process.stdout.write('Waiting for Strapi to come online...\n');
  await new Promise(resolve => setTimeout(resolve, initTime)).then(ping);
  process.stdout.write('Strapi online!\n');
};
