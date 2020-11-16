module.exports = ({ env }) => ({
  load: {
    before: ['api'],
  },
  settings: {
    api: {
      enabled: true,
    },
    logger: {
      level: env('NODE_ENV') === 'production' ? 'info' : 'debug',
      requests: env('NODE_ENV') !== 'production',
    },
  },
});
