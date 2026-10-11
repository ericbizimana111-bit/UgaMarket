const app = require('./src/app');
const env = require('./src/config/env');
const prisma = require('./src/config/db');
const logger = require('./src/utils/logger');

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info(`🚀 UgaMarket API running on ${env.HOST}:${env.PORT} [${env.NODE_ENV}]`);
  logger.info(`📍 Connected to PostgreSQL via Prisma`);
  startBackgroundJobs();
});

// Background jobs (in-process; safe to run on every instance: each job is
// idempotent and guarded against overlapping runs).
const jobTimers = [];
function startBackgroundJobs() {
  const callService = require('./src/services/call.service');
  const newsletter = require('./src/services/newsletter.service');
  const messaging = require('./src/services/messaging');

  // Prove the email provider works now, not when the first customer signs up.
  messaging
    .verifyEmailProvider()
    .then((r) => {
      if (r.ok) logger.info(`[email] provider ${r.provider} ready${r.reason ? ` (${r.reason})` : ''}`);
      else logger.error(`[email] provider ${r.provider} NOT working: ${r.reason}${r.hint ? ` | ${r.hint}` : ''}`);
    })
    .catch((error) => logger.warn('[email] provider check failed:', error.message));

  // Calls cannot survive a restart (their signalling lived in the old process).
  callService
    .closeCallsInterruptedByRestart()
    .then((n) => n > 0 && logger.info(`[jobs] closed ${n} call(s) interrupted by the restart`))
    .catch((error) => logger.warn('[jobs] call cleanup failed:', error.message));

  if (env.NEW_ARRIVALS_DIGEST_MINUTES > 0) {
    const run = () =>
      newsletter
        .runNewArrivalsDigest()
        .then((r) => r.products > 0 && logger.info(`[jobs] new-arrivals digest: ${r.products} products, ${r.emails} emails, ${r.notifications} in-app`))
        .catch((error) => logger.warn('[jobs] new-arrivals digest failed:', error.message));
    const first = setTimeout(run, 30 * 1000);
    const every = setInterval(run, env.NEW_ARRIVALS_DIGEST_MINUTES * 60 * 1000);
    first.unref();
    every.unref();
    jobTimers.push(first, every);
  }
}

// Graceful Shutdown Handling
const shutdown = async (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  jobTimers.forEach((t) => clearTimeout(t));
  server.close(async () => {
    logger.info('HTTP server closed.');
    await prisma.$disconnect();
    logger.info('Database connection closed.');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown due to timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
