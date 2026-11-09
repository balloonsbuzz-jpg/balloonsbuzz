// Google Drive -> gallery sync, as a background job (button in Gallery + every N minutes).
const { env } = require('../config/env');
const { query } = require('../db/pool');
const logger = require('../lib/logger');
const { enqueue, PermanentError } = require('../queue/jobs');
const { runImport } = require('./importer');
const { driveSource, DriveError } = require('./sources/drive');

async function gallerySyncJob(payload, job) {
  if (!env.GDRIVE_API_KEY) throw new PermanentError('GDRIVE_API_KEY is not set');
  // A first full sync downloads hundreds of photos: keep the job's lock fresh so the
  // stale-job sweeper (5 min) doesn't hand it to another worker mid-run.
  const beat = setInterval(() => {
    query(`UPDATE jobs SET locked_at = now() WHERE id = $1 AND status = 'running'`, [job.id]).catch(() => {});
  }, 60_000);
  try {
    const source = driveSource({ folderId: env.GDRIVE_FOLDER_ID, apiKey: env.GDRIVE_API_KEY, base: env.GDRIVE_API_BASE });
    await runImport({ tenantId: job.tenant_id, source, triggeredBy: payload.triggered_by || null });
  } catch (err) {
    // Drive misconfiguration or a sync already running won't fix itself by retrying now.
    if (err instanceof DriveError || err.status === 409) throw new PermanentError(err.message);
    throw err;
  } finally {
    clearInterval(beat);
  }
}

/** Queues a sync for every tenant whose last Drive sync is older than the interval. */
async function scheduleDriveSyncs() {
  if (!env.GDRIVE_API_KEY || !env.GDRIVE_SYNC_INTERVAL_MIN) return 0;
  const { rows } = await query(
    `SELECT t.id FROM tenants t
      WHERE NOT EXISTS (SELECT 1 FROM gallery_sync_runs r
                         WHERE r.tenant_id = t.id AND r.source = 'drive'
                           AND r.started_at > now() - make_interval(mins => $1))`, [env.GDRIVE_SYNC_INTERVAL_MIN]);
  let n = 0;
  for (const t of rows) {
    const job = await enqueue({ tenantId: t.id, name: 'gallery_sync', payload: {}, uniqueKey: `gallery_sync:${t.id}`, maxAttempts: 1 });
    if (job) n += 1;
  }
  if (n) logger.info('scheduled Drive gallery sync', { tenants: n });
  return n;
}

module.exports = { gallerySyncJob, scheduleDriveSyncs };
