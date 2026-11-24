// What /api/health reports. Uptime monitors call it every minute, so it stays cheap and
// says nothing secret: just whether the database answers and the worker is checking in.
const os = require('os');
const { query } = require('../db/pool');
const { env } = require('../config/env');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const STARTED_AT = new Date();

/** Called by the worker every minute. */
async function beat(info = {}) {
  await query(
    `INSERT INTO worker_heartbeats (worker_id, created_at, beat_at, info) VALUES ($1, $2, now(), $3)
     ON CONFLICT (worker_id) DO UPDATE SET beat_at = now(), info = EXCLUDED.info`,
    [WORKER_ID, STARTED_AT, JSON.stringify(info)]);
  // forget workers that are long gone (old containers)
  await query(`DELETE FROM worker_heartbeats WHERE beat_at < now() - interval '1 day'`);
}

async function stopBeating() {
  await query(`DELETE FROM worker_heartbeats WHERE worker_id = $1`, [WORKER_ID]).catch(() => {});
}

/**
 * @returns {Promise<{httpStatus:number, body:object}>}
 * The worker only fails the check in production; in development and tests it is optional.
 * On Vercel there is no worker process: "worker" then says whether /internal/cron is being
 * called. Replies work without it, so it is reported but does not fail the check.
 */
async function check() {
  const t0 = Date.now();
  let db = 'ok';
  let row = null;
  try {
    ({ rows: [row] } = await query(`
      SELECT extract(epoch FROM now() - (SELECT max(beat_at) FROM worker_heartbeats))::int AS worker_age,
             (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at < now() - interval '5 minutes')::int AS backlog`));
  } catch {
    db = 'down';
  }
  const dbMs = Date.now() - t0;
  const worker = db === 'down' ? 'unknown' : row.worker_age == null ? 'missing' : row.worker_age > env.WORKER_STALE_AFTER_SEC ? 'stale' : 'ok';
  const queue = db === 'down' ? 'unknown' : row.backlog > 0 ? 'backlog' : 'ok';
  const workerRequired = env.NODE_ENV === 'production' && !env.VERCEL;
  const healthy = db === 'ok' && (!workerRequired || worker === 'ok');
  return {
    httpStatus: healthy ? 200 : 503,
    body: { status: healthy ? (queue === 'ok' ? 'ok' : 'busy') : 'degraded', db, db_ms: dbMs, worker, queue },
  };
}

module.exports = { beat, stopBeating, check, WORKER_ID };
