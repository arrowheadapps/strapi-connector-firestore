module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'firestore',
      options: {
        useEmulator: env('NODE_ENV') !== 'production'
      }
    }
  },
});
