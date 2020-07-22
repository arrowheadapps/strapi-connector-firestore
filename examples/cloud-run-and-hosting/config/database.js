module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'firestore',
      options: {
        useEmulator: process.env.NODE_ENV !== 'production'
      }
    }
  },
});
