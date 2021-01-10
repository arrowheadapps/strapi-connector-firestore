module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'firestore',
      settings: {
        // This not required for production
        // But it is required for the Firestore emulator UI otherwise
        // it won't show any data
        projectId: env('npm_package_project_id'),
      },
      options: {
        useEmulator: env('NODE_ENV') !== 'production',
        logQueries: env('NODE_ENV') !== 'production',
      }
    }
  },
});
