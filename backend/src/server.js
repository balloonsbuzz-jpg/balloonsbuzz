const { env } = require('./config/env');
const logger = require('./lib/logger');
const { pool } = require('./db/pool');
const { createApp } = require('./app');

const bus = require('./realtime/bus');

const server = createApp().listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`, { env: env.NODE_ENV }));
bus.start().then(() => logger.info('realtime listener ready'));

function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  server.close(() => bus.stop().then(() => pool.end()).finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('unhandled promise rejection', { error: err?.message, stack: err?.stack }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception, exiting so Docker restarts the API', { error: err.message, stack: err.stack });
  setTimeout(() => process.exit(1), 500).unref();
});
