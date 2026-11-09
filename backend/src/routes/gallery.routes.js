const express = require('express');
const { z } = require('zod');
const { env } = require('../config/env');
const { query } = require('../db/pool');
const { ah, parse, conflict, notFound } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const audit = require('../services/audit.service');
const gallery = require('../gallery/gallery.service');
const { driverName } = require('../gallery/storage');
const jobs = require('../queue/jobs');

const router = express.Router();
const read = requirePermission('gallery:read');
const write = requirePermission('gallery:write');
const uuid = z.string().uuid();
const money = z.coerce.number().int().min(0).max(10_000_000);

const listSchema = z.object({
  status: z.enum(['all', 'sendable', 'needs_price', 'generic', 'hidden', 'removed']).default('all'),
  q: z.string().trim().max(100).optional(),
  package_id: uuid.optional(),
  theme_id: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/items', read, ah(async (req, res) => {
  const f = parse(listSchema, req.query);
  res.json(await gallery.list(req.user.tenantId, { status: f.status, q: f.q, packageId: f.package_id, themeId: f.theme_id, limit: f.limit, offset: f.offset }));
}));

router.get('/stats', read, ah(async (req, res) => res.json(await gallery.stats(req.user.tenantId))));

router.get('/items/:id', read, ah(async (req, res) => {
  res.json({ item: await gallery.get(req.user.tenantId, parse(uuid, req.params.id)) });
}));

const overrideSchema = z.object({
  override_title: z.string().trim().min(1).max(120).nullable(),
  override_package_id: uuid.nullable(),
  override_theme_id: uuid.nullable(),
  override_occasion_id: uuid.nullable(),
  override_price_min: money.nullable(),
  override_price_max: money.nullable(),
  override_hidden: z.boolean(),
  override_force_sendable: z.boolean(),
}).partial().strict();

router.patch('/items/:id', write, ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const patch = parse(overrideSchema, req.body);
  const { before, after } = await gallery.updateOverrides(req.user.tenantId, id, req.user.id, patch);
  const pick = (r) => (r ? Object.fromEntries(Object.keys(patch).map((k) => [k, r[k]])) : null);
  await audit.fromReq(req, { action: 'gallery_item.update', entityType: 'gallery_item', entityId: id, before: pick(before), after: pick(after) });
  res.json({ item: after || before });
}));

// "What would the bot send?" Same picker the AI tool uses.
const searchSchema = z.object({
  theme: z.string().trim().max(60).optional(),
  occasion: z.string().trim().max(60).optional(),
  package: z.string().trim().max(60).optional(),
  budget_min: money.optional(),
  budget_max: money.optional(),
  style: z.string().trim().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(5).default(3),
}).strict();

router.post('/search', read, ah(async (req, res) => {
  const b = parse(searchSchema, req.body);
  res.json(await gallery.searchPhotos({
    tenantId: req.user.tenantId, theme: b.theme, occasion: b.occasion, packageRef: b.package,
    budgetMin: b.budget_min, budgetMax: b.budget_max, style: b.style, limit: b.limit,
  }));
}));

// ── import / Drive sync ─────────────────────────────────────────
router.get('/config', read, ah(async (req, res) => {
  res.json({
    drive_connected: !!env.GDRIVE_API_KEY,
    drive_folder_url: `https://drive.google.com/drive/folders/${env.GDRIVE_FOLDER_ID}`,
    sync_interval_min: env.GDRIVE_API_KEY ? env.GDRIVE_SYNC_INTERVAL_MIN : 0,
    storage: driverName(),
  });
}));

router.get('/runs', read, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.source, r.status, r.stats, r.error, r.started_at, r.finished_at, u.full_name AS triggered_by_name
       FROM gallery_sync_runs r LEFT JOIN users u ON u.id = r.triggered_by
      WHERE r.tenant_id = $1 ORDER BY r.started_at DESC LIMIT 20`, [req.user.tenantId]);
  res.json({ runs: rows });
}));

router.get('/runs/:id', read, ah(async (req, res) => {
  const { rows: [run] } = await query(`SELECT * FROM gallery_sync_runs WHERE id = $1 AND tenant_id = $2`, [parse(uuid, req.params.id), req.user.tenantId]);
  if (!run) throw notFound('Import not found');
  res.json({ run });
}));

router.post('/sync', write, ah(async (req, res) => {
  if (!env.GDRIVE_API_KEY) throw conflict('Google Drive is not connected yet (GDRIVE_API_KEY). Use the zip import until then.');
  const job = await jobs.enqueue({
    tenantId: req.user.tenantId, name: 'gallery_sync', payload: { triggered_by: req.user.id },
    uniqueKey: `gallery_sync:${req.user.tenantId}`, maxAttempts: 1,
  });
  if (!job) throw conflict('A Drive sync is already queued or running.');
  await audit.fromReq(req, { action: 'gallery.sync_requested', entityType: 'job', entityId: job.id });
  res.status(202).json({ job_id: job.id });
}));

module.exports = router;
