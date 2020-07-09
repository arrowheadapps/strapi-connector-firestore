module.exports = ({ env }) => {
  const config = {
    host: env('HOST', '0.0.0.0'),
    port: env.int('PORT', 8081)
  };

  if (process.env.NODE_ENV === 'production') {
    config.url = '/api';
    config.admin = {
      url: '/',
      serveAdminPanel: false,
    };
  }

  return config;
};
