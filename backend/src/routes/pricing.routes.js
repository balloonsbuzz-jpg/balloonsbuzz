// Pricing & Rules: design categories, themes, price rules, negotiation limits,
// distance slabs + base location, and the quote calculator.
const express = require('express');
const { z } = require('zod');
const { env } = require('../config/env');
const { query, withTx } = require('../db/pool');
const { ah, parse, badRequest, notFound, conflict } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const audit = require('../services/audit.service');
const pricing = require('../pricing/pricing.service');
const { invalidateCatalog } = require('../gallery/gallery.service');

const router = express.Router();
const read = requirePermission('pricing:read');
const write = requirePermission('pricing:write');
const uuid = z.string().uuid();
const money = z.coerce.number().min(0).max(10_000_000);
const key = z.string().regex(/^[a-z0-9_]{2,50}$/, 'Use lower-case letters, digits and _');

/** UPDATE <table> SET <patch> WHERE id AND tenant; returns {before, after}. */
async function patchRow(table, tenantId, id, patch, db = { query }) {
  const { rows: [before] } = await db.query(`SELECT * FROM ${table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!before) throw notFound();
  const fields = Object.keys(patch);
  if (!fields.length) return { before, after: before };
  const { rows: [after] } = await db.query(
    `UPDATE ${table} SET ${fields.map((f, i) => `${f} = $${i + 3}`).join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, ...fields.map((f) => (Array.isArray(patch[f]) || typeof patch[f] !== 'object' || patch[f] === null ? patch[f] : JSON.stringify(patch[f])))]);
  return { before, after };
}

function pgError(err) {
  if (err.code === '23505') return conflict('That already exists');
  if (err.code === '23P01') return badRequest('Distance bands overlap');
  if (err.code === '23514') return badRequest(`Invalid values (${err.constraint})`);
  if (err.code === '23503') return badRequest('Unknown reference');
  return err;
}
const guard = (fn) => ah(async (req, res) => { try { await fn(req, res); } catch (err) { throw pgError(err); } });

async function assertOwned(tenantId, table, id) {
  if (!id) return;
  const { rowCount } = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!rowCount) throw badRequest(`Unknown ${table.replace(/s$/, '')}`);
}

// ── catalogue ───────────────────────────────────────────────────
router.get('/catalog', read, ah(async (req, res) => {
  const t = req.user.tenantId;
  const [packages, themes, occasions, photoCounts] = await Promise.all([
    query(`SELECT * FROM packages WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY sort_order, name`, [t]),
    query(`SELECT th.id, th.key, th.name, th.is_active,
                  COALESCE(json_agg(json_build_object('id', a.id, 'alias', a.alias) ORDER BY a.alias) FILTER (WHERE a.id IS NOT NULL), '[]') AS aliases
             FROM themes th LEFT JOIN theme_aliases a ON a.theme_id = th.id
            WHERE th.tenant_id = $1 AND th.deleted_at IS NULL GROUP BY th.id ORDER BY th.name`, [t]),
    query(`SELECT id, key, name, aliases, is_active FROM occasions WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY sort_order`, [t]),
    query(`SELECT package_id, theme_id, count(*)::int AS n FROM gallery_items
            WHERE tenant_id = $1 AND is_sendable GROUP BY GROUPING SETS ((package_id), (theme_id))`, [t]),
  ]);
  const byPkg = {}; const byTheme = {};
  for (const r of photoCounts.rows) {
    if (r.package_id) byPkg[r.package_id] = r.n;
    else if (r.theme_id) byTheme[r.theme_id] = r.n;
  }
  res.json({
    packages: packages.rows.map((p) => ({ ...p, sendable_photos: byPkg[p.id] || 0 })),
    themes: themes.rows.map((th) => ({ ...th, sendable_photos: byTheme[th.id] || 0 })),
    occasions: occasions.rows,
  });
}));

const packagePatch = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullable(),
  inclusions: z.array(z.string().trim().min(1).max(120)).max(30),
  price_min: money.nullable(),
  price_max: money.nullable(),
  price_confirmed: z.boolean(),
  unit_label: z.string().trim().max(30).nullable(),
  min_quantity: z.coerce.number().int().min(1).max(10000).nullable(),
  is_active: z.boolean(),
}).partial().strict();

router.patch('/packages/:id', write, guard(async (req, res) => {
  const patch = parse(packagePatch, req.body);
  const { before, after } = await patchRow('packages', req.user.tenantId, parse(uuid, req.params.id), patch);
  invalidateCatalog(req.user.tenantId);
  await audit.fromReq(req, { action: 'package.update', entityType: 'package', entityId: after.id, before, after });
  res.json({ package: after });
}));

const themeCreate = z.object({
  name: z.string().trim().min(2).max(60),
  key: key.optional(),
  aliases: z.array(z.string().trim().min(2).max(60)).max(30).default([]),
}).strict();

router.post('/themes', write, guard(async (req, res) => {
  const b = parse(themeCreate, req.body);
  const k = b.key || b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
  if (!/^[a-z0-9_]{2,50}$/.test(k)) throw badRequest('Give the theme a key (letters and digits)');
  const theme = await withTx(async (c) => {
    const { rows: [th] } = await c.query(`INSERT INTO themes (tenant_id, key, name) VALUES ($1,$2,$3) RETURNING *`, [req.user.tenantId, k, b.name]);
    for (const a of new Set([b.name, ...b.aliases].map((x) => x.toLowerCase().trim()))) {
      await c.query(`INSERT INTO theme_aliases (tenant_id, theme_id, alias) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, alias) DO NOTHING`, [req.user.tenantId, th.id, a]);
    }
    return th;
  });
  invalidateCatalog(req.user.tenantId);
  await audit.fromReq(req, { action: 'theme.create', entityType: 'theme', entityId: theme.id, after: theme });
  res.status(201).json({ theme });
}));

router.patch('/themes/:id', write, guard(async (req, res) => {
  const patch = parse(z.object({ name: z.string().trim().min(2).max(60), is_active: z.boolean() }).partial().strict(), req.body);
  const { before, after } = await patchRow('themes', req.user.tenantId, parse(uuid, req.params.id), patch);
  invalidateCatalog(req.user.tenantId);
  await audit.fromReq(req, { action: 'theme.update', entityType: 'theme', entityId: after.id, before, after });
  res.json({ theme: after });
}));

router.post('/themes/:id/aliases', write, guard(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { alias } = parse(z.object({ alias: z.string().trim().min(2).max(60) }).strict(), req.body);
  await assertOwned(req.user.tenantId, 'themes', id);
  const { rows: [a] } = await query(
    `INSERT INTO theme_aliases (tenant_id, theme_id, alias) VALUES ($1,$2,$3) RETURNING id, alias`, [req.user.tenantId, id, alias.toLowerCase()]);
  invalidateCatalog(req.user.tenantId);
  await audit.fromReq(req, { action: 'theme.alias_add', entityType: 'theme', entityId: id, after: a });
  res.status(201).json({ alias: a });
}));

router.delete('/aliases/:id', write, guard(async (req, res) => {
  const { rows: [a] } = await query(`DELETE FROM theme_aliases WHERE id = $1 AND tenant_id = $2 RETURNING *`, [parse(uuid, req.params.id), req.user.tenantId]);
  if (!a) throw notFound();
  invalidateCatalog(req.user.tenantId);
  await audit.fromReq(req, { action: 'theme.alias_remove', entityType: 'theme', entityId: a.theme_id, before: a });
  res.status(204).end();
}));

// ── price rules ─────────────────────────────────────────────────
const ruleBody = z.object({
  package_id: uuid,
  theme_id: uuid.nullable().default(null),
  occasion_id: uuid.nullable().default(null),
  rule_type: z.enum(['base_price', 'surcharge', 'unit_price']).default('base_price'),
  price_min: money,
  price_max: money,
  priority: z.coerce.number().int().min(-100).max(100).default(0),
  valid_from: z.string().date().nullable().default(null),
  valid_to: z.string().date().nullable().default(null),
  is_active: z.boolean().default(true),
  price_confirmed: z.boolean().default(false),
  notes: z.string().trim().max(300).nullable().default(null),
}).strict();

router.get('/rules', read, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, p.name AS package_name, t.name AS theme_name, o.name AS occasion_name
       FROM pricing_rules r JOIN packages p ON p.id = r.package_id
       LEFT JOIN themes t ON t.id = r.theme_id LEFT JOIN occasions o ON o.id = r.occasion_id
      WHERE r.tenant_id = $1 ORDER BY p.sort_order, r.rule_type, r.priority DESC`, [req.user.tenantId]);
  res.json({ rules: rows });
}));

router.post('/rules', write, guard(async (req, res) => {
  const b = parse(ruleBody, req.body);
  await Promise.all([assertOwned(req.user.tenantId, 'packages', b.package_id), assertOwned(req.user.tenantId, 'themes', b.theme_id), assertOwned(req.user.tenantId, 'occasions', b.occasion_id)]);
  const cols = Object.keys(b);
  const { rows: [rule] } = await query(
    `INSERT INTO pricing_rules (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [req.user.tenantId, ...cols.map((c) => b[c])]);
  await audit.fromReq(req, { action: 'pricing_rule.create', entityType: 'pricing_rule', entityId: rule.id, after: rule });
  res.status(201).json({ rule });
}));

router.patch('/rules/:id', write, guard(async (req, res) => {
  const patch = parse(ruleBody.partial(), req.body);
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  await Promise.all([assertOwned(req.user.tenantId, 'packages', patch.package_id), assertOwned(req.user.tenantId, 'themes', patch.theme_id), assertOwned(req.user.tenantId, 'occasions', patch.occasion_id)]);
  const { before, after } = await patchRow('pricing_rules', req.user.tenantId, parse(uuid, req.params.id), patch);
  await audit.fromReq(req, { action: 'pricing_rule.update', entityType: 'pricing_rule', entityId: after.id, before, after });
  res.json({ rule: after });
}));

router.delete('/rules/:id', write, guard(async (req, res) => {
  const { rows: [r] } = await query(`DELETE FROM pricing_rules WHERE id = $1 AND tenant_id = $2 RETURNING *`, [parse(uuid, req.params.id), req.user.tenantId]);
  if (!r) throw notFound();
  await audit.fromReq(req, { action: 'pricing_rule.delete', entityType: 'pricing_rule', entityId: r.id, before: r });
  res.status(204).end();
}));

// ── negotiation limits ──────────────────────────────────────────
const negBody = z.object({
  scope: z.enum(['global', 'package', 'theme']),
  package_id: uuid.nullable().default(null),
  theme_id: uuid.nullable().default(null),
  max_discount_pct: z.coerce.number().min(0).max(100).nullable().default(null),
  max_discount_amount: money.nullable().default(null),
  min_final_price: money.nullable().default(null),
  concession_step_pct: z.coerce.number().gt(0).max(100).default(5),
  max_rounds: z.coerce.number().int().min(0).max(10).default(2),
  applies_to_addons: z.boolean().default(false),
  applies_to_distance_charge: z.boolean().default(false),
  is_active: z.boolean().default(true),
  notes: z.string().trim().max(300).nullable().default(null),
}).strict();

router.get('/negotiation', read, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT n.*, p.name AS package_name, t.name AS theme_name
       FROM negotiation_rules n LEFT JOIN packages p ON p.id = n.package_id LEFT JOIN themes t ON t.id = n.theme_id
      WHERE n.tenant_id = $1 AND n.is_active
      ORDER BY CASE n.scope WHEN 'global' THEN 0 WHEN 'package' THEN 1 ELSE 2 END, p.sort_order, t.name`, [req.user.tenantId]);
  res.json({ rules: rows });
}));

router.post('/negotiation', write, guard(async (req, res) => {
  const b = parse(negBody, req.body);
  await Promise.all([assertOwned(req.user.tenantId, 'packages', b.package_id), assertOwned(req.user.tenantId, 'themes', b.theme_id)]);
  const cols = Object.keys(b);
  const { rows: [rule] } = await query(
    `INSERT INTO negotiation_rules (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [req.user.tenantId, ...cols.map((c) => b[c])]);
  await audit.fromReq(req, { action: 'negotiation_rule.create', entityType: 'negotiation_rule', entityId: rule.id, after: rule });
  res.status(201).json({ rule });
}));

router.patch('/negotiation/:id', write, guard(async (req, res) => {
  const patch = parse(negBody.partial().omit({ scope: true, package_id: true, theme_id: true }), req.body);
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  const { before, after } = await patchRow('negotiation_rules', req.user.tenantId, parse(uuid, req.params.id), patch);
  await audit.fromReq(req, { action: 'negotiation_rule.update', entityType: 'negotiation_rule', entityId: after.id, before, after });
  res.json({ rule: after });
}));

router.delete('/negotiation/:id', write, guard(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { rows: [rule] } = await query(`SELECT scope FROM negotiation_rules WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
  if (!rule) throw notFound();
  if (rule.scope === 'global') throw badRequest('The overall limit can be changed but not removed');
  // Deactivated, not deleted: issued quotes keep pointing at the rule they were priced with.
  const { before, after } = await patchRow('negotiation_rules', req.user.tenantId, id, { is_active: false });
  await audit.fromReq(req, { action: 'negotiation_rule.delete', entityType: 'negotiation_rule', entityId: after.id, before });
  res.status(204).end();
}));

// ── distance ────────────────────────────────────────────────────
router.get('/distance', read, ah(async (req, res) => {
  const t = req.user.tenantId;
  const [slabs, base] = await Promise.all([
    query(`SELECT * FROM distance_slabs WHERE tenant_id = $1 AND is_active ORDER BY min_km`, [t]),
    query(`SELECT base_address, base_lat, base_lng, road_factor, max_service_km FROM business_settings WHERE tenant_id = $1`, [t]),
  ]);
  res.json({ slabs: slabs.rows, base: base.rows[0] || null, road_distance: env.GOOGLE_MAPS_API_KEY ? 'google' : 'estimate' });
}));

const slabItem = z.object({
  min_km: z.coerce.number().min(0).max(1000),
  max_km: z.coerce.number().gt(0).max(1000).nullable(),
  charge_type: z.enum(['free', 'flat', 'per_km', 'not_serviceable']),
  amount: money.default(0),
  label: z.string().trim().max(60).nullable().default(null),
  price_confirmed: z.boolean().default(false),
}).strict();

// The whole table is replaced at once, so bands can be re-cut without fighting the overlap rule.
router.put('/distance/slabs', write, guard(async (req, res) => {
  const { slabs } = parse(z.object({ slabs: z.array(slabItem).min(1).max(20) }).strict(), req.body);
  const sorted = [...slabs].sort((a, b) => a.min_km - b.min_km);
  sorted.forEach((s, i) => {
    if (s.max_km != null && s.max_km <= s.min_km) throw badRequest(`Band ${i + 1}: "to" must be more than "from"`);
    if (s.charge_type === 'free') s.amount = 0;
    if (i > 0 && sorted[i - 1].max_km == null) throw badRequest('Only the last band can be open-ended');
    if (i > 0 && sorted[i - 1].max_km !== s.min_km) throw badRequest(`Bands must join up: ${sorted[i - 1].max_km} km ≠ ${s.min_km} km`);
  });
  if (sorted[0].min_km !== 0) throw badRequest('The first band must start at 0 km');
  const t = req.user.tenantId;
  const result = await withTx(async (c) => {
    const { rows: before } = await c.query(`DELETE FROM distance_slabs WHERE tenant_id = $1 RETURNING *`, [t]);
    const after = [];
    for (const s of sorted) {
      const { rows: [r] } = await c.query(
        `INSERT INTO distance_slabs (tenant_id, min_km, max_km, charge_type, amount, label, price_confirmed)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [t, s.min_km, s.max_km, s.charge_type, s.amount, s.label, s.price_confirmed]);
      after.push(r);
    }
    return { before, after };
  });
  await audit.fromReq(req, { action: 'distance_slabs.replace', entityType: 'distance_slabs', entityId: null, before: result.before, after: result.after });
  res.json({ slabs: result.after });
}));

const baseBody = z.object({
  base_address: z.string().trim().max(300).nullable(),
  base_lat: z.coerce.number().min(-90).max(90).nullable(),
  base_lng: z.coerce.number().min(-180).max(180).nullable(),
  road_factor: z.coerce.number().min(1).max(3),
  max_service_km: z.coerce.number().gt(0).max(1000).nullable(),
}).partial().strict();

router.put('/distance/base', write, guard(async (req, res) => {
  const patch = parse(baseBody, req.body);
  if (('base_lat' in patch) !== ('base_lng' in patch)) throw badRequest('Send both latitude and longitude');
  const { rows: [s] } = await query(`SELECT id FROM business_settings WHERE tenant_id = $1`, [req.user.tenantId]);
  if (!s) throw notFound('Business settings missing');
  const { before, after } = await patchRow('business_settings', req.user.tenantId, s.id, patch);
  await audit.fromReq(req, { action: 'business_settings.base_location', entityType: 'business_settings', entityId: s.id, before, after });
  res.json({ base: { base_address: after.base_address, base_lat: after.base_lat, base_lng: after.base_lng, road_factor: after.road_factor, max_service_km: after.max_service_km } });
}));

const location = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }).strict();

router.post('/distance/check', read, ah(async (req, res) => {
  const b = parse(z.object({ km: z.coerce.number().min(0).max(2000).optional(), location: location.optional() }).strict()
    .refine((v) => v.km != null || v.location, 'Give a distance or a location'), req.body);
  res.json(await pricing.distanceQuote({ tenantId: req.user.tenantId, km: b.km ?? null, location: b.location || null }));
}));

// ── quote calculator (same engine the AI uses) ──────────────────
const quoteBody = z.object({
  package_id: uuid.optional(),
  gallery_item_id: uuid.optional(),
  theme_id: uuid.optional(),
  occasion_id: uuid.optional(),
  addons: z.array(z.object({ package_id: uuid, quantity: z.coerce.number().int().min(1).max(10000).default(1) }).strict()).max(10).default([]),
  km: z.coerce.number().min(0).max(2000).optional(),
  location: location.optional(),
  event_date: z.string().date().optional(),
  offer: money.optional(),
  current_ask: money.optional(),
  rounds_used: z.coerce.number().int().min(0).max(20).default(0),
}).strict().refine((b) => b.package_id || b.gallery_item_id, 'Choose a design category or a photo');

router.post('/quote', read, ah(async (req, res) => {
  const b = parse(quoteBody, req.body);
  const input = {
    tenantId: req.user.tenantId, packageId: b.package_id, galleryItemId: b.gallery_item_id, themeId: b.theme_id, occasionId: b.occasion_id,
    addons: b.addons, km: b.km ?? null, location: b.location || null, eventDate: b.event_date || null,
  };
  if (b.offer == null) return res.json({ quote: await pricing.quote(input) });
  const r = await pricing.negotiateOffer({ ...input, offer: b.offer, currentAsk: b.current_ask ?? null, roundsUsed: b.rounds_used });
  const { quote, ...negotiation } = r;
  return res.json({ quote, negotiation });
}));

module.exports = router;
