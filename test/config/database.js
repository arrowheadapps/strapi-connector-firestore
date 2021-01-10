const flattening = {
  flatten_all: [/.*/],
  flatten_none: [],

  // Flatten models that are referred to
  // by non-flattened models
  flatten_mixed_src: [
    /category/,
    /tag/,
    /user/,
    /collector/,
  ],

  // Flatten models that refer to
  // non-flattened models
  flatten_mixed_target: [
    /reference/,
    /article/,
    /paniniCard/,
  ],
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
        maxQuerySize: 0,

        // TODO: Allow on all EXCEPT internal Strapi models
        allowNonNativeQueries: true,///^(?!strapi::).*/,
        
        // Use flattening config from env variable
        // Default to no flattening
        flattenModels: flattening[process.env.FLATTENING] || []
      },
    }
  },
});
