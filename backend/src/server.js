// Entry point. On a server it listens; on Vercel it exports the Express app. Vercel picks the
// first app/index/server file that imports express, so no other file here may have those names.
const express = require('express');

function loadApp() {
  if (!process.env.VERCEL) return require('./create-app').createApp();
  try {
    return require('./create-app').createApp();
  } catch (err) {
    // A bad setting would otherwise only show as FUNCTION_INVOCATION_FAILED. The message names
    // the settings (never their values) and goes to the function logs, not to visitors.
    console.error(`BalloonsBuzz API cannot start: ${err.message}`);
    const broken = express();
    broken.disable('x-powered-by');
    broken.use((req, res) => res.status(503).json({ error: 'The API is not configured correctly. See the function logs.' }));
    return broken;
  }
}

const app = loadApp();
module.exports = app;

if (!process.env.VERCEL) {
  const { env } = require('./config/env');
  const logger = require('./lib/logger');
  const { pool } = require('./db/pool');
  const bus = require('./realtime/bus');

  const server = app.listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`, { env: env.NODE_ENV }));
  bus.start().then(() => logger.info('realtime listener ready'));

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => bus.stop().then(() => pool.end()).finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error('unhandled promise rejection', { error: err?.message, stack: err?.stack }));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception, exiting so Docker restarts the API', { error: err.message, stack: err.stack });
    setTimeout(() => process.exit(1), 500).unref();
  });
}
