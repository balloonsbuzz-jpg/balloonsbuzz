// Templates, broadcasts, automations/follow-ups and tags (M8).
const express = require('express');
const { z } = require('zod');
const { query } = require('../db/pool');
const { ah, parse, badRequest, notFound } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const { limits } = require('../middleware/rateLimits');
const audit = require('../services/audit.service');
const templates = require('../templates/templates.service');
const render = require('../templates/render');
const broadcasts = require('../broadcasts/broadcasts.service');
const automations = require('../automations/automations.service');

const router = express.Router();
const uuid = z.string().uuid();
const can = requirePermission;

// ── templates ───────────────────────────────────────────────────
router.get('/templates', can('templates:read'), ah(async (req, res) => {
  res.json({
    templates: await templates.list(req.user.tenantId),
    variables: render.VARIABLES.map(([key, label, example]) => ({ key, label, example })),
    purposes: templates.PURPOSES,
    recommended: templates.RECOMMENDED.map((r) => ({ name: r.name, category: r.category, purpose: r.purpose, body: r.body })),
  });
}));

router.post('/templates/sync', can('templates:write'), limits.heavyJob, ah(async (req, res) => {
  const r = await templates.sync(req.user.tenantId);
  await audit.fromReq(req, { action: 'templates.sync', entityType: 'templates', entityId: null, after: r });
  res.json({ ...r, templates: await templates.list(req.user.tenantId) });
}));

router.post('/templates/recommended/:name', can('templates:write'), limits.metaCall, ah(async (req, res) => {
  const name = parse(z.string().regex(/^[a-z0-9_]{1,100}$/), req.params.name);
  const t = await templates.submitRecommended(req.user.tenantId, name);
  await audit.fromReq(req, { action: 'templates.submit', entityType: 'template', entityId: t.id, after: { name } });
  res.status(201).json({ template: t });
}));

router.patch('/templates/:id', can('templates:write'), ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(z.object({
    purpose: z.string().nullable().optional(),
    variable_map: z.record(z.string().regex(/^\d+$/), z.string()).optional(),
  }).strict(), req.body);
  const t = await templates.update(req.user.tenantId, id, b);
  await audit.fromReq(req, { action: 'template.update', entityType: 'template', entityId: id, after: b });
  res.json({ template: t });
}));

// ── tags ────────────────────────────────────────────────────────
router.get('/tags', can('contacts:read'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.name, t.color, count(ct.contact_id)::int AS contacts
       FROM tags t LEFT JOIN contact_tags ct ON ct.tag_id = t.id WHERE t.tenant_id = $1 GROUP BY t.id ORDER BY t.name`, [req.user.tenantId]);
  res.json({ tags: rows });
}));

const PALETTE = ['#B4566A', '#C9A227', '#4F8A8B', '#7B61FF', '#E07A5F', '#3D9970', '#9CA3AF'];

router.put('/contacts/:id/tags', can('contacts:write'), ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { names } = parse(z.object({ names: z.array(z.string().trim().min(1).max(40)).max(20) }).strict(), req.body);
  const { rows: [ct] } = await query(`SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [id, req.user.tenantId]);
  if (!ct) throw notFound('Contact not found');
  const unique = [...new Map(names.map((n) => [n.toLowerCase(), n])).values()];
  const ids = [];
  for (const [i, name] of unique.entries()) {
    const { rows: [t] } = await query(
      `INSERT INTO tags (tenant_id, name, color) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET updated_at = tags.updated_at RETURNING id`,
      [req.user.tenantId, name, PALETTE[i % PALETTE.length]]);
    ids.push(t.id);
  }
  await query(`DELETE FROM contact_tags WHERE contact_id = $1 AND NOT (tag_id = ANY($2::uuid[]))`, [id, ids]);
  for (const tagId of ids) {
    await query(`INSERT INTO contact_tags (contact_id, tag_id, tenant_id, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id, tagId, req.user.tenantId, req.user.id]);
  }
  await audit.fromReq(req, { action: 'contact.tags', entityType: 'contact', entityId: id, after: { tags: unique } });
  const { rows } = await query(`SELECT t.id, t.name, t.color FROM contact_tags x JOIN tags t ON t.id = x.tag_id WHERE x.contact_id = $1 ORDER BY t.name`, [id]);
  res.json({ tags: rows });
}));

router.get('/contacts/:id/tags', can('contacts:read'), ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { rows } = await query(
    `SELECT t.id, t.name, t.color FROM contact_tags x JOIN tags t ON t.id = x.tag_id WHERE x.contact_id = $1 AND x.tenant_id = $2 ORDER BY t.name`,
    [id, req.user.tenantId]);
  res.json({ tags: rows });
}));

// ── broadcasts ──────────────────────────────────────────────────
const audience = z.object({
  tags_any: z.array(uuid).max(20).optional(),
  lead_status: z.array(z.enum(['new', 'qualifying', 'quoted', 'negotiating', 'won', 'lost', 'stale'])).max(7).optional(),
  occasion_ids: z.array(uuid).max(20).optional(),
  booked: z.enum(['any', 'yes', 'no']).optional(),
  active_within_days: z.coerce.number().int().min(1).max(3650).optional(),
}).strict();
const statics = z.record(z.string().regex(/^\d+$/), z.string().trim().max(500));

router.get('/broadcasts', can('broadcasts:read'), ah(async (req, res) => res.json({ broadcasts: await broadcasts.list(req.user.tenantId) })));

router.post('/broadcasts/audience', can('broadcasts:read'), ah(async (req, res) => {
  res.json(await broadcasts.preview(req.user.tenantId, parse(audience, req.body)));
}));

router.get('/broadcasts/:id', can('broadcasts:read'), ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const q = parse(z.object({ status: z.enum(['pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped', 'replied']).optional() }), req.query);
  const [broadcast, list] = await Promise.all([broadcasts.get(req.user.tenantId, id), broadcasts.recipients(req.user.tenantId, id, { status: q.status })]);
  res.json({ broadcast, recipients: list });
}));

const createBody = z.object({ name: z.string().trim().min(2).max(100), template_id: uuid, variables: statics.default({}), audience_filter: audience.default({}) }).strict();

router.post('/broadcasts', can('broadcasts:write'), ah(async (req, res) => {
  res.status(201).json({ broadcast: await broadcasts.create(req, parse(createBody, req.body)) });
}));

router.patch('/broadcasts/:id', can('broadcasts:write'), ah(async (req, res) => {
  res.json({ broadcast: await broadcasts.update(req, parse(uuid, req.params.id), parse(createBody.partial(), req.body)) });
}));

router.delete('/broadcasts/:id', can('broadcasts:write'), ah(async (req, res) => {
  await broadcasts.remove(req, parse(uuid, req.params.id));
  res.status(204).end();
}));

router.post('/broadcasts/:id/schedule', can('broadcasts:write'), ah(async (req, res) => {
  const b = parse(z.object({ at: z.string().datetime({ offset: true }).nullable().optional() }).strict(), req.body);
  res.json({ broadcast: await broadcasts.schedule(req, parse(uuid, req.params.id), { at: b.at || null }) });
}));

for (const action of ['pause', 'resume', 'cancel']) {
  router.post(`/broadcasts/:id/${action}`, can('broadcasts:write'), ah(async (req, res) => {
    res.json({ broadcast: await broadcasts[action](req, parse(uuid, req.params.id)) });
  }));
}

router.post('/broadcasts/:id/retry-failed', can('broadcasts:write'), ah(async (req, res) => {
  res.json(await broadcasts.retryFailed(req, parse(uuid, req.params.id)));
}));

// ── automations & follow-ups ────────────────────────────────────
router.get('/automations', can('automations:read'), ah(async (req, res) => res.json({ automations: await automations.list(req.user.tenantId) })));

router.patch('/automations/:id', can('automations:write'), ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(z.object({
    is_active: z.boolean().optional(),
    trigger_config: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    action_config: z.record(z.string(), z.string()).optional(),
  }).strict(), req.body);
  if (!Object.keys(b).length) throw badRequest('Nothing to change');
  const { before, after } = await automations.update(req.user.tenantId, id, b);
  await audit.fromReq(req, { action: 'automation.update', entityType: 'automation', entityId: id,
    before: { is_active: before.is_active, trigger_config: before.trigger_config, action_config: before.action_config },
    after: { is_active: after.is_active, trigger_config: after.trigger_config, action_config: after.action_config } });
  res.json({ automation: after });
}));

router.post('/automations/run', can('automations:write'), limits.heavyJob, ah(async (req, res) => {
  res.json({ created: await automations.runDue({ tenantId: req.user.tenantId }) });
}));

router.get('/followups', can('automations:read'), ah(async (req, res) => {
  const q = parse(z.object({ status: z.enum(['pending', 'sent', 'cancelled', 'skipped', 'failed', 'all']).default('pending') }), req.query);
  res.json({ followups: await automations.followups(req.user.tenantId, q) });
}));

router.post('/followups/:id/cancel', can('automations:write'), ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  await automations.cancelFollowup(req.user.tenantId, id);
  await audit.fromReq(req, { action: 'followup.cancel', entityType: 'followup', entityId: id });
  res.json({ ok: true });
}));

module.exports = router;
