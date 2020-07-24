module.exports = ({ env }) => {
  const config = {
    host: env('HOST', '0.0.0.0'),
    port: env.int('PORT', 8081),
    admin: {
      auth: {
        secret: env('ADMIN_JWT_SECRET'),
      },
    }
  };

  // Don't serve the admin panel in production
  // Instead it is deployed on Firebase hosting
  if (env('NODE_ENV') === 'production') {
    config.url = 'https://{YOUR_CLOUD_RUN_URL}';
    config.admin.url = '/';
    config.admin.serveAdminPanel = false;
  }

  return config;
};
