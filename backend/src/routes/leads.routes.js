// Contacts & Leads: everyone who enquired, what we know about their event, and where they are.
const express = require('express');
const { z } = require('zod');
const { query } = require('../db/pool');
const { ah, parse, notFound, badRequest } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const audit = require('../services/audit.service');
const gallery = require('../gallery/gallery.service');

const router = express.Router();
const read = requirePermission('leads:read');
const write = requirePermission('leads:write');
const uuid = z.string().uuid();

const LEAD_SELECT = `
  SELECT l.*, ct.name AS contact_name, ct.phone AS contact_phone, o.name AS occasion_name, t.name AS theme_name, p.name AS package_name,
         u.full_name AS assigned_user_name, cv.handling_mode,
         (SELECT q.final_price FROM quotes q WHERE q.lead_id = l.id AND q.status IN ('issued','negotiating','accepted') ORDER BY q.created_at DESC LIMIT 1) AS latest_price,
         (SELECT b.booking_code FROM bookings b WHERE b.lead_id = l.id AND b.status <> 'cancelled' ORDER BY b.created_at DESC LIMIT 1) AS booking_code
    FROM leads l JOIN contacts ct ON ct.id = l.contact_id
    LEFT JOIN occasions o ON o.id = l.occasion_id LEFT JOIN themes t ON t.id = l.theme_id LEFT JOIN packages p ON p.id = l.package_id
    LEFT JOIN users u ON u.id = l.assigned_user_id LEFT JOIN conversations cv ON cv.id = l.conversation_id`;

const listQuery = z.object({
  status: z.enum(['open', 'new', 'qualifying', 'quoted', 'negotiating', 'won', 'lost', 'stale', 'all']).default('open'),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/', read, ah(async (req, res) => {
  const f = parse(listQuery, req.query);
  const where = ['l.tenant_id = $1', 'l.deleted_at IS NULL', `ct.source <> 'sandbox'`];
  const params = [req.user.tenantId];
  if (f.status === 'open') where.push(`l.status IN ('new','qualifying','quoted','negotiating')`);
  else if (f.status !== 'all') { params.push(f.status); where.push(`l.status = $${params.length}`); }
  if (f.q) {
    params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(ct.name ILIKE $${params.length} OR ct.phone ILIKE $${params.length} OR l.venue_address ILIKE $${params.length} OR l.theme_text ILIKE $${params.length})`);
  }
  const w = where.join(' AND ');
  const [{ rows }, { rows: [{ total }] }, { rows: counts }] = await Promise.all([
    query(`${LEAD_SELECT} WHERE ${w} ORDER BY l.last_activity_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`, params),
    query(`SELECT count(*)::int AS total FROM leads l JOIN contacts ct ON ct.id = l.contact_id WHERE ${w}`, params),
    query(`SELECT l.status, count(*)::int AS n FROM leads l JOIN contacts ct ON ct.id = l.contact_id
            WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND ct.source <> 'sandbox' GROUP BY l.status`, [req.user.tenantId]),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  byStatus.open = ['new', 'qualifying', 'quoted', 'negotiating'].reduce((s, k) => s + (byStatus[k] || 0), 0);
  byStatus.all = counts.reduce((s, c) => s + c.n, 0);
  res.json({ leads: rows, total, counts: byStatus });
}));

router.get('/:id', read, ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { rows: [lead] } = await query(`${LEAD_SELECT} WHERE l.id = $1 AND l.tenant_id = $2 AND l.deleted_at IS NULL`, [id, req.user.tenantId]);
  if (!lead) throw notFound('Lead not found');
  const [quotes, bookings, history] = await Promise.all([
    query(`SELECT q.id, q.status, q.final_price, q.floor_price, q.list_price, q.addons_total, q.distance_charge, q.rounds_used, q.created_at, q.line_items,
                  p.name AS package_name, g.title AS photo_title
             FROM quotes q JOIN packages p ON p.id = q.package_id LEFT JOIN gallery_items g ON g.id = q.gallery_item_id
            WHERE q.lead_id = $1 ORDER BY q.created_at DESC`, [id]),
    query(`SELECT id, booking_code, status, event_date, agreed_price, advance_status FROM bookings WHERE contact_id = $1 AND deleted_at IS NULL ORDER BY event_date DESC`, [lead.contact_id]),
    query(`SELECT l2.id, l2.status, l2.created_at, o.name AS occasion_name FROM leads l2 LEFT JOIN occasions o ON o.id = l2.occasion_id
            WHERE l2.contact_id = $1 AND l2.id <> $2 AND l2.deleted_at IS NULL ORDER BY l2.created_at DESC LIMIT 10`, [lead.contact_id, id]),
  ]);
  res.json({ lead, quotes: quotes.rows, bookings: bookings.rows, other_leads: history.rows });
}));

const patchBody = z.object({
  status: z.enum(['new', 'qualifying', 'quoted', 'negotiating', 'lost', 'stale']),
  lost_reason: z.string().trim().min(3).max(300),
  occasion: z.string().trim().max(60).nullable(),
  theme: z.string().trim().max(100).nullable(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  venue_address: z.string().trim().max(300).nullable(),
  guest_count: z.coerce.number().int().min(1).max(10000).nullable(),
  budget_min: z.coerce.number().min(0).max(10_000_000).nullable(),
  budget_max: z.coerce.number().min(0).max(10_000_000).nullable(),
  assigned_user_id: z.string().uuid().nullable(),
  notes: z.string().trim().max(2000).nullable(),
}).partial().strict();

router.patch('/:id', write, ah(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(patchBody, req.body);
  const { rows: [before] } = await query(`SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [id, req.user.tenantId]);
  if (!before) throw notFound('Lead not found');
  if (before.status === 'won') throw badRequest('This lead is booked; change the booking instead.');
  if (b.status === 'lost' && !b.lost_reason) throw badRequest('Say why the lead was lost');

  const set = {};
  for (const k of ['status', 'lost_reason', 'event_date', 'venue_address', 'guest_count', 'budget_min', 'budget_max', 'assigned_user_id', 'notes']) {
    if (k in b) set[k] = b[k];
  }
  if (b.status && b.status !== 'lost') set.lost_reason = null;
  if ('occasion' in b) set.occasion_id = b.occasion ? (await gallery.resolveOccasion(req.user.tenantId, b.occasion))?.id ?? null : null;
  if ('theme' in b) {
    const t = b.theme ? await gallery.resolveTheme(req.user.tenantId, b.theme) : null;
    set.theme_id = t ? t.id : null;
    set.theme_text = t || !b.theme ? null : b.theme;
  }
  const fields = Object.keys(set);
  if (!fields.length) throw badRequest('Nothing to change');
  try {
    await query(`UPDATE leads SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')}, last_activity_at = now() WHERE id = $1`, [id, ...fields.map((f) => set[f])]);
  } catch (err) {
    if (err.code === '23514') throw badRequest(`Invalid values (${err.constraint})`);
    throw err;
  }
  await audit.fromReq(req, { action: 'lead.update', entityType: 'lead', entityId: id,
    before: Object.fromEntries(fields.map((f) => [f, before[f]])), after: set });
  const { rows: [lead] } = await query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
  res.json({ lead });
}));

module.exports = router;
