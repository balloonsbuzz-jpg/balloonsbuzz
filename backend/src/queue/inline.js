// Serverless replacement for the worker process (src/worker.js). On Vercel nothing runs
// between requests, so after a webhook or a change in the dashboard the same function
// instance works through the queue, kept alive with waitUntil. Jobs due later (reminders,
// long retries, follow-ups) run when /internal/cron is called. Not used outside Vercel.
const { env } = require('../config/env');
const { query } = require('../db/pool');
const logger = require('../lib/logger');
const { createWorker } = require('./worker-loop');

const BUDGET_MS = 240_000;      // below the 300s function limit, so a running job can finish
const LOOKAHEAD_MS = 20_000;    // wait in place for jobs due this soon (AI debounce, typing delay, first retries)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Milliseconds until the next queued job is due (0 = due now), or null when there is none. */
async function nextDueMs() {
  const { rows: [r] } = await query(
    `SELECT (extract(epoch FROM min(run_at) - clock_timestamp()) * 1000)::float8 AS ms
       FROM jobs WHERE status = 'queued' AND queue = 'default'`);
  return r.ms == null ? null : Math.max(0, r.ms);
}

async function drainOnce(end) {
  const worker = createWorker({ handlers: require('./handlers'), concurrency: env.WORKER_CONCURRENCY });
  while (Date.now() < end) {
    const started = await worker.tick();
    if (started || worker.running()) {
      await sleep(150);
    } else {
      const ms = await nextDueMs();
      if (ms == null || ms > LOOKAHEAD_MS || Date.now() + ms > end) break;
      await sleep(Math.max(50, Math.min(ms, 1000)));
    }
  }
  await worker.stop();
}

let active = null;
let again = false;

/** One drain per instance; a call during a drain makes it look once more before it ends. */
function drain(budgetMs = BUDGET_MS) {
  again = true;
  if (!active) {
    const end = Date.now() + budgetMs;
    active = (async () => {
      while (again && Date.now() < end) {
        again = false;
        await drainOnce(end);
      }
    })()
      .catch((err) => logger.error('inline queue drain failed', { error: err.message }))
      .finally(() => { active = null; });
  }
  return active;
}

/** Express middleware: once this response is sent, run whatever it queued. */
function drainAfterResponse(req, res, next) {
  if (env.VERCEL && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const { waitUntil } = require('@vercel/functions');
    waitUntil(new Promise((resolve) => { res.once('close', resolve); }).then(() => drain()));
  }
  next();
}

module.exports = { drain, drainAfterResponse };
