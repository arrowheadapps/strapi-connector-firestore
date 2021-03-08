module.exports = ({ env }) => {

  // Use Cloud Storage for production environment only
  if (env('NODE_ENV') === 'production') {
    return {
      upload: {
        provider: 'google-cloud-storage',
        providerOptions: {
          // The GCP_PROJECT variable is set by the deployment script in production
          bucketName: `${env('GCP_PROJECT')}.appspot.com`,
          basePath: '/',
          publicFiles: true,
          uniform: false,
        },
      },
    };
  }
};
