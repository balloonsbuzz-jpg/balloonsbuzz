// Background worker: processes webhook events and sends messages (and, later,
// AI replies, follow-ups and broadcasts). Run alongside the API: npm run worker
const { env } = require('./config/env');
const logger = require('./lib/logger');
const { pool } = require('./db/pool');
const { createWorker } = require('./queue/worker-loop');
const handlers = require('./queue/handlers');

const worker = createWorker({ handlers, concurrency: env.WORKER_CONCURRENCY, pollMs: env.WORKER_POLL_MS });
worker.start();

// Periodic Drive gallery sync (only when GDRIVE_API_KEY is set).
const { scheduleDriveSyncs } = require('./gallery/sync.job');
const { runDue } = require('./automations/automations.service');
const tickSchedules = () => {
  scheduleDriveSyncs().catch((err) => logger.warn('gallery sync scheduling failed', { error: err.message }));
  // Follow-ups and reminders (each one is created once per quote/booking, so ticking often is safe)
  runDue().catch((err) => logger.warn('automations failed', { error: err.message }));
};
const scheduleTimer = setInterval(tickSchedules, 60_000);
tickSchedules();

async function shutdown(signal) {
  logger.info(`${signal} received, finishing running jobs`);
  clearInterval(scheduleTimer);
  await worker.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
