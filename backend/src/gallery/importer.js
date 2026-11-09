// Gallery import/sync: one code path for the zip import and the Google Drive sync.
//
// For every photo in the source:
//   1. parse folder + file name -> design category, theme, occasion, style, price (names.js)
//   2. bytes -> sha256; new content is normalised (normalize.js) and uploaded once (storage.js)
//   3. upsert the gallery item; only parsed_* / source columns are written,
//      override_* columns belong to admins and survive every re-sync
// Photos that disappeared from the source are marked is_present_in_source=false (never deleted).
// A second run over the same source changes 0 rows.
const crypto = require('crypto');
const { query } = require('../db/pool');
const { conflict } = require('../lib/errors');
const logger = require('../lib/logger');
const bus = require('../realtime/bus');
const { classify, buildContext } = require('./names');
const { normalizeImage, MIME_BY_FORMAT } = require('./normalize');
const { storage } = require('./storage');

const STALE_RUN_MINUTES = 120;

async function loadCatalogContext(tenantId, db = { query }) {
  const [packages, themes, aliases, occasions] = await Promise.all([
    db.query(`SELECT id, key, name, kind, folder_names FROM packages WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active`, [tenantId]),
    db.query(`SELECT id, key, name FROM themes WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active`, [tenantId]),
    db.query(`SELECT a.alias, a.theme_id, t.key, t.name FROM theme_aliases a JOIN themes t ON t.id = a.theme_id
               WHERE a.tenant_id = $1 AND t.deleted_at IS NULL AND t.is_active`, [tenantId]),
    db.query(`SELECT id, key, name, aliases FROM occasions WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active`, [tenantId]),
  ]);
  return buildContext({ packages: packages.rows, themes: themes.rows, themeAliases: aliases.rows, occasions: occasions.rows });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const iso = (d) => (d ? new Date(d).toISOString() : null);
const n = (v) => (v == null ? null : Number(v));

const ITEM_FIELDS = [
  'asset_id', 'source_path', 'drive_file_id', 'drive_md5', 'drive_modified_at', 'parsed_title', 'name_quality',
  'parsed_package_id', 'parsed_theme_id', 'parsed_occasion_id', 'parsed_style', 'parsed_price_min', 'parsed_price_max',
  'parsed_price_source', 'is_present_in_source',
];

function sameValue(field, a, b) {
  if (field === 'drive_modified_at') return iso(a) === iso(b);
  if (field === 'parsed_price_min' || field === 'parsed_price_max') return n(a) === n(b);
  return (a ?? null) === (b ?? null);
}

/** Runs `fn` over items with at most `limit` in flight. */
async function eachLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i; i += 1;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function startRun(tenantId, sourceName, triggeredBy) {
  await query(
    `UPDATE gallery_sync_runs SET status = 'failed', error = 'Interrupted (worker restarted)', finished_at = now()
      WHERE tenant_id = $1 AND status = 'running' AND started_at < now() - make_interval(mins => $2)`,
    [tenantId, STALE_RUN_MINUTES]);
  try {
    const { rows: [run] } = await query(
      `INSERT INTO gallery_sync_runs (tenant_id, source, triggered_by) VALUES ($1, $2, $3) RETURNING *`,
      [tenantId, sourceName, triggeredBy]);
    return run;
  } catch (err) {
    if (err.code === '23505') throw conflict('A gallery import is already running. Try again when it finishes.');
    throw err;
  }
}

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {{name:'zip'|'drive'|'upload', list:() => Promise<Array<{path:string, read:() => Promise<Buffer>, driveFileId?:string, md5?:string, modifiedAt?:string}>>, close?:() => Promise<void>}} p.source
 * @param {string|null} [p.triggeredBy] user id; null = scheduled
 * @param {number} [p.concurrency]
 * @param {(stats) => void} [p.onProgress]
 */
async function runImport({ tenantId, source, triggeredBy = null, concurrency = 4, onProgress }) {
  const run = await startRun(tenantId, source.name, triggeredBy);
  const store = storage();
  const stats = { seen: 0, added: 0, updated: 0, unchanged: 0, removed: 0, assets_added: 0, skipped: 0, errors: 0 };
  const report = { generic: [], unpriced: [], no_category: [], skipped: [], errors: [] };
  const publishProgress = () => bus.publish({ type: 'gallery.sync', tenantId, run_id: run.id });

  try {
    await store.ensureReady();
    const ctx = await loadCatalogContext(tenantId);
    const entries = await source.list();

    const { rows: existing } = await query(
      `SELECT i.*, a.sha256 FROM gallery_items i JOIN gallery_assets a ON a.id = i.asset_id
        WHERE i.tenant_id = $1 AND i.source = $2`, [tenantId, source.name]);
    const byPath = new Map(existing.map((r) => [r.source_path, r]));
    const byDrive = new Map(existing.filter((r) => r.drive_file_id).map((r) => [r.drive_file_id, r]));
    const { rows: assetRows } = await query(`SELECT id, sha256 FROM gallery_assets WHERE tenant_id = $1`, [tenantId]);
    const assets = new Map(assetRows.map((r) => [r.sha256, r.id]));
    const creating = new Map();
    const seen = new Set();

    async function ensureAsset(sha, buffer) {
      if (assets.has(sha)) return assets.get(sha);
      if (!creating.has(sha)) {
        creating.set(sha, (async () => {
          const img = await normalizeImage(buffer);
          const key = `${tenantId}/${sha.slice(0, 2)}/${sha}.jpg`;
          const thumbKey = `${tenantId}/${sha.slice(0, 2)}/${sha}_t.jpg`;
          const url = await store.put(key, img.image.buffer, 'image/jpeg');
          const thumbUrl = await store.put(thumbKey, img.thumb.buffer, 'image/jpeg');
          const { rows: [a] } = await query(
            `INSERT INTO gallery_assets (tenant_id, sha256, storage_key, public_url, thumb_storage_key, thumb_url, mime_type,
                                         size_bytes, width, height, original_mime_type, original_size_bytes)
             VALUES ($1,$2,$3,$4,$5,$6,'image/jpeg',$7,$8,$9,$10,$11)
             ON CONFLICT (tenant_id, sha256) DO UPDATE SET public_url = EXCLUDED.public_url
             RETURNING id`,
            [tenantId, sha, key, url, thumbKey, thumbUrl, img.image.size, img.image.width, img.image.height,
              MIME_BY_FORMAT[img.original.format] || `image/${img.original.format}`, img.original.size]);
          stats.assets_added += 1;
          assets.set(sha, a.id);
          return a.id;
        })().finally(() => creating.delete(sha)));
      }
      return creating.get(sha);
    }

    await eachLimit(entries, concurrency, async (e) => {
      stats.seen += 1;
      try {
        const c = classify(e.path, ctx);
        if (!c.isImage) { stats.skipped += 1; report.skipped.push(e.path); return; }

        const prev = (e.driveFileId && byDrive.get(e.driveFileId)) || byPath.get(e.path) || null;
        let assetId;
        if (prev && e.md5 && prev.drive_md5 === e.md5) {
          assetId = prev.asset_id;                       // Drive says the bytes didn't change: no download
        } else {
          const buf = await e.read();
          assetId = await ensureAsset(sha256(buf), buf);
        }

        const fields = {
          asset_id: assetId,
          source_path: c.path,
          drive_file_id: e.driveFileId || null,
          drive_md5: e.md5 || null,
          drive_modified_at: e.modifiedAt || null,
          parsed_title: c.title,
          name_quality: c.quality,
          parsed_package_id: c.package ? c.package.id : null,
          parsed_theme_id: c.theme ? c.theme.id : null,
          parsed_occasion_id: c.occasion ? c.occasion.id : null,
          parsed_style: c.style,
          parsed_price_min: c.price ? c.price.min : null,
          parsed_price_max: c.price ? c.price.max : null,
          parsed_price_source: c.priceSource,
          is_present_in_source: true,
        };

        if (c.quality === 'generic') report.generic.push(c.path);
        else if (!c.price) report.unpriced.push(c.path);
        if (!c.package) report.no_category.push(c.path);

        if (!prev) {
          const cols = ['tenant_id', 'source', ...ITEM_FIELDS, 'last_synced_at'];
          const vals = [tenantId, source.name, ...ITEM_FIELDS.map((f) => fields[f])];
          const { rows: [row] } = await query(
            `INSERT INTO gallery_items (${cols.join(', ')})
             VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}, now()) RETURNING id`, vals);
          seen.add(row.id);
          stats.added += 1;
        } else {
          seen.add(prev.id);
          const changed = ITEM_FIELDS.filter((f) => !sameValue(f, prev[f], fields[f]));
          if (!changed.length) { stats.unchanged += 1; return; }
          await query(
            `UPDATE gallery_items SET ${changed.map((f, i) => `${f} = $${i + 2}`).join(', ')}, last_synced_at = now()
              WHERE id = $1`, [prev.id, ...changed.map((f) => fields[f])]);
          stats.updated += 1;
        }
      } catch (err) {
        stats.errors += 1;
        report.errors.push({ path: e.path, error: String(err.message || err).slice(0, 300) });
        logger.warn('gallery import: file failed', { path: e.path, error: err.message });
      } finally {
        if (stats.seen % 25 === 0) {
          await query(`UPDATE gallery_sync_runs SET stats = $2 WHERE id = $1`, [run.id, { ...stats, total: entries.length }]);
          publishProgress();
          if (onProgress) onProgress({ ...stats, total: entries.length });
        }
      }
    });

    // Gone from the source -> no longer sendable (rows and overrides are kept, in case it comes back).
    const gone = existing.filter((r) => r.is_present_in_source && !seen.has(r.id)).map((r) => r.id);
    if (gone.length) {
      await query(`UPDATE gallery_items SET is_present_in_source = false WHERE id = ANY($1::uuid[])`, [gone]);
    }
    stats.removed = gone.length;

    const { rows: [totals] } = await query(
      `SELECT count(*) FILTER (WHERE is_sendable)::int AS sendable,
              count(*) FILTER (WHERE is_present_in_source)::int AS present,
              count(*) FILTER (WHERE is_present_in_source AND name_quality = 'generic')::int AS generic,
              count(*) FILTER (WHERE is_present_in_source AND name_quality <> 'generic' AND price_min IS NULL)::int AS unpriced
         FROM gallery_items WHERE tenant_id = $1 AND source = $2`, [tenantId, source.name]);
    Object.assign(stats, totals, { total: entries.length });

    const status = stats.errors ? 'partial' : 'succeeded';
    const { rows: [done] } = await query(
      `UPDATE gallery_sync_runs SET status = $2, stats = $3, report = $4, finished_at = now() WHERE id = $1 RETURNING *`,
      [run.id, status, stats, report]);
    publishProgress();
    logger.info('gallery import finished', { source: source.name, ...stats });
    return done;
  } catch (err) {
    await query(
      `UPDATE gallery_sync_runs SET status = 'failed', error = $2, stats = $3, report = $4, finished_at = now() WHERE id = $1`,
      [run.id, String(err.message || err).slice(0, 500), stats, report]);
    publishProgress();
    throw err;
  } finally {
    if (source.close) await source.close().catch(() => {});
  }
}

module.exports = { runImport, loadCatalogContext };
