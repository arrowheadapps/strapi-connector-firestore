module.exports = ({ env }) => {

  // Use Cloud Storage for production environment only
  if (env('NODE_ENV') === 'production') {
    return {
      upload: {
        provider: 'google-cloud-storage',
        providerOptions: {
          bucketName: `${env('npm_package_project_id')}.appspot.com`,
          basePath: '/',
          publicFiles: true,
        },
      },
    };
  }
};
