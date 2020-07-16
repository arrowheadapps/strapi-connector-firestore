const flattening = {
  flatten_all: [/.*/],
  flatten_none: [],
};

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
        allowNonNativeQueries: true,
        
        // Use flattening config from env variable
        // Default to no flattening
        flattenModels: flattening[process.env.FLATTENING] || []
      },
    }
  },
});
