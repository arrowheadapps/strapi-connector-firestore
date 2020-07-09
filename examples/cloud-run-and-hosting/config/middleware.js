module.exports = ({ env }) => ({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    requests: false,
  },
});
