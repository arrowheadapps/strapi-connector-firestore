module.exports = ({ env }) => ({
  settings: {
    logger: {
      level: env('NODE_ENV') === 'production' ? 'info' : 'debug',
      requests: false,
    },
  },
});
