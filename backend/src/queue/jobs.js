// Postgres-backed job queue. Claims with FOR UPDATE SKIP LOCKED so any number of
// worker processes can run without double-processing a job.
const { query } = require('../db/pool');

/** Thrown by a handler to say "retry later" with a reason (counts as an attempt). */
class RetryableError extends Error {
  constructor(message, { delayMs } = {}) {
    super(message);
    this.retryable = true;
    this.delayMs = delayMs;
  }
}

/** Thrown by a handler to stop retrying immediately. */
class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

/**
 * Enqueue a job. Pass `db` (a pg client) to enqueue inside the caller's transaction.
 * Returns the job row, or null when a job with the same active unique_key exists.
 */
async function enqueue({ tenantId = null, name, payload = {}, queue = 'default', runAt, delayMs, priority = 0, maxAttempts = 5, uniqueKey }, db = { query }) {
  const at = runAt || (delayMs ? new Date(Date.now() + delayMs) : new Date());
  const { rows } = await db.query(
    `INSERT INTO jobs (tenant_id, queue, name, payload, run_at, priority, max_attempts, unique_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (unique_key) WHERE unique_key IS NOT NULL AND status IN ('queued','running') DO NOTHING
     RETURNING *`,
    [tenantId, queue, name, JSON.stringify(payload), at, priority, maxAttempts, uniqueKey || null]);
  return rows[0] || null;
}

async function claim({ workerId, queues = ['default'], limit = 1 }) {
  const { rows } = await query(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_at <= now() AND queue = ANY($2)
         ORDER BY priority DESC, run_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING *`, [workerId, queues, limit]);
  return rows;
}

async function complete(job) {
  await query(`UPDATE jobs SET status = 'done', completed_at = now(), locked_by = NULL, locked_at = NULL, last_error = NULL
                WHERE id = $1`, [job.id]);
}

/** Exponential backoff with jitter: ~2s, 4s, 8s, 16s ... capped at 10 min. */
function backoffMs(attempt, base = 2000, cap = 10 * 60_000) {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

async function fail(job, err) {
  const message = String(err?.message || err).slice(0, 2000);
  const exhausted = job.attempts >= job.max_attempts;
  if (err?.permanent || exhausted) {
    await query(`UPDATE jobs SET status = 'failed', last_error = $2, locked_by = NULL, locked_at = NULL, completed_at = now()
                  WHERE id = $1`, [job.id, message]);
    return { final: true };
  }
  const delay = err?.delayMs ?? backoffMs(job.attempts);
  await query(`UPDATE jobs SET status = 'queued', last_error = $2, locked_by = NULL, locked_at = NULL,
                      run_at = now() + make_interval(secs => $3)
                WHERE id = $1`, [job.id, message, delay / 1000]);
  return { final: false, delayMs: delay };
}

/** Jobs whose worker died mid-run go back to the queue. */
async function recoverStale(staleAfterMs = 5 * 60_000) {
  const { rowCount } = await query(
    `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL,
            last_error = COALESCE(last_error, '') || ' [recovered: worker lost]'
      WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)`, [staleAfterMs / 1000]);
  return rowCount;
}

module.exports = { enqueue, claim, complete, fail, recoverStale, backoffMs, RetryableError, PermanentError };
