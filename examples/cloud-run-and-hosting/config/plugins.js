module.exports = ({ env }) => {
  
  // Use Cloud Storage for production environment only
  const upload = env('NODE_ENV') === 'production'
    ? {
      provider: 'google-cloud-storage',
      providerOptions: {
        bucketName: '{PROJECT_ID}.appspot.com',
        basePath: '/',
        publicFiles: true,
      },
    }
    : {};

  return {
    upload
  };
};
