module.exports = ({ env }) => ({
  host: 'localhost',
  port: 1337,
  admin: {
    serveAdminPanel: false,
    watchIgnoreFiles: [
      // Prevent Firestore log file from triggering Strapi restart
      '*-debug.log'
    ],
    auth: {
      secret: env('ADMIN_JWT_SECRET') || 'd399f313-cdde-4abd-86e7-1b040b441d09',
    },
  },
});
