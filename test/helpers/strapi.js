let instance;

async function startStrapi() {
  if (!instance) {
    process.stdout.write('Starting Strapi... ');
    process.env.BROWSER = 'none';
    process.env.STRAPI_HIDE_STARTUP_MESSAGE = 'true';

    // Allow changed configuration files to be reloaded from disk rather than cache
    jest.resetModules();

    /** the following code in copied from `./node_modules/strapi/lib/Strapi.js` */
    await require('strapi')().load();
    instance = strapi; // strapi is global now

    await new Promise(async (resolve, reject) => {
      instance.start(resolve).catch(reject);
    });

    process.stdout.write('Strapi started!\n');
  }
  return instance;
}

async function reloadStrapi() {
  await stopStrapi();
  await startStrapi();
}


async function stopStrapi() {
  if (instance) {
    // The instance.stop() function causes the process to exit
    // So we stop the server etc without exiting the entire process
    process.stdout.write('Stopping Strapi... ');
    if (instance.server) {
      await new Promise(r => instance.server.close(r));
      instance.server.destroy();
    }
    process.send('stop');
    instance = null;
    process.stdout.write('Strapi stopped!\n');
  }
}

module.exports = { 
  startStrapi,
  reloadStrapi,
  stopStrapi
};
