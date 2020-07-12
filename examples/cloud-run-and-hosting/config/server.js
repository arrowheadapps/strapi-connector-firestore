module.exports = ({ env }) => {
  const config = {
    host: env('HOST', '0.0.0.0'),
    port: env.int('PORT', 8081)
  };

  // Don't serve the admin panel in production
  // Instead it is deployed on Firebase hosting
  if (process.env.NODE_ENV === 'production') {
    config.url = 'https://{YOUR_CLOUD_RUN_URL}';
    config.admin = {
      url: '/',
      serveAdminPanel: false,
    };
  }

  return config;
};
