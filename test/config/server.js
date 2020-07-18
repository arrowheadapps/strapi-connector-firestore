module.exports = ({ env }) => ({
  host: 'localhost',
  port: 1337,
  admin: {
    serveAdminPanel: false,
    watchIgnoreFiles: [
      // Prevent Firestore log file from triggering Strapi restart
      '*-debug.log'
    ],
  },
});
