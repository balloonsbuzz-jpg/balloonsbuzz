const { env } = require('./config/env');
const logger = require('./lib/logger');
const { pool } = require('./db/pool');
const { createApp } = require('./app');

const server = createApp().listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`, { env: env.NODE_ENV }));

function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
