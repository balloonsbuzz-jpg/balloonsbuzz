// Background worker: processes webhook events and sends messages (and, later,
// AI replies, follow-ups and broadcasts). Run alongside the API: npm run worker
const { env } = require('./config/env');
const logger = require('./lib/logger');
const { pool } = require('./db/pool');
const { createWorker } = require('./queue/worker-loop');
const handlers = require('./queue/handlers');

const worker = createWorker({ handlers, concurrency: env.WORKER_CONCURRENCY, pollMs: env.WORKER_POLL_MS });
worker.start();

async function shutdown(signal) {
  logger.info(`${signal} received, finishing running jobs`);
  await worker.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
