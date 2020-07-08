module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'firestore',
      settings: {
        projectId: 'test-project-id',
      },
      options: {
        useEmulator: true,
      },
    }
  },
});
