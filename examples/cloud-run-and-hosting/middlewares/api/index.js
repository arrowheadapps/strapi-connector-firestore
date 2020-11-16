module.exports = strapi => ({
  initialize: () => {
    const prefix = '/api';

    // Install a middleware that removes '/api' from the start of the URL
    // This happens when called via the Firebase Hosting proxy
    strapi.app.use(async (ctx, next) => {
      if (ctx.path.startsWith(prefix)) {
        ctx.path = ctx.path.slice(prefix.length);
      }

      // I don't know why but the Firebase CDN seems to cache everything by default (?)
      // So explicitly set no caching on all requests
      // Caching can be re-enabled explicity by setting the header in a route handler
      ctx.set('Cache-Control', 'private, max-age=0');

      await next();
    });
  },
});
