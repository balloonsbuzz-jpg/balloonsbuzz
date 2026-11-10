const express = require('express');
const { z } = require('zod');
const { query } = require('../db/pool');
const { ah, parse } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const { limits } = require('../middleware/rateLimits');
const accounts = require('../whatsapp/account.service');
const outbound = require('../whatsapp/outbound.service');
const audit = require('../services/audit.service');

const router = express.Router();
const read = requirePermission('settings:read');
const write = requirePermission('settings:write');

router.get('/whatsapp', read, ah(async (req, res) => {
  res.json({ account: await accounts.getPrimary(req.user.tenantId), webhook: accounts.webhookInfo() });
}));

router.put('/whatsapp', write, ah(async (req, res) => {
  res.json({ account: await accounts.upsertPrimary(req, req.body) });
}));

router.post('/whatsapp/health', write, limits.metaCall, ah(async (req, res) => res.json(await accounts.healthCheck(req))));

router.get('/whatsapp/events', read, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT id, event_type, event_key, status, attempts, error_message, received_at, processed_at
       FROM webhook_events WHERE tenant_id = $1 OR tenant_id IS NULL
      ORDER BY received_at DESC LIMIT 30`, [req.user.tenantId]);
  res.json({ events: rows });
}));

const testSchema = z.object({
  phone: z.string().min(8).max(20),
  type: z.enum(['text', 'template']),
  text: z.string().max(1000).optional(),
  template_name: z.string().regex(/^[a-z0-9_]{1,512}$/).optional(),
  template_language: z.string().min(2).max(10).optional(),
}).strict();

// Sends a test message from Settings (text inside the 24h window, or a template like hello_world).
router.post('/whatsapp/test-message', write, limits.metaCall, ah(async (req, res) => {
  const b = parse(testSchema, req.body);
  const content = b.type === 'text'
    ? { text: b.text || 'Hello from BalloonsBuzz 🎈 (test message)' }
    : { name: b.template_name || 'hello_world', language: b.template_language || 'en_US' };
  const msg = await outbound.sendToPhone({
    tenantId: req.user.tenantId, phone: b.phone, type: b.type, content, senderType: 'agent', senderUserId: req.user.id,
  });
  await audit.fromReq(req, { action: 'whatsapp_account.test_message', entityType: 'message', entityId: msg.id, after: { to: b.phone, type: b.type } });
  res.status(202).json({ message: { id: msg.id, status: msg.status } });
}));

router.get('/whatsapp/test-message/:id', read, ah(async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const { rows } = await query(
    `SELECT id, status, wa_message_id, error_code, error_message, sent_at, delivered_at, read_at, failed_at
       FROM messages WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
  res.json({ message: rows[0] || null });
}));

// ── business details (Settings → Business). The base pin lives in Pricing & Rules → Distance. ──
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const businessSchema = z.object({
  business_name: z.string().trim().min(2).max(100),
  base_address: z.string().trim().max(300).nullable(),
  advance_type: z.enum(['percent', 'fixed']),
  advance_value: z.coerce.number().min(0).max(1_000_000).nullable(),
  min_lead_time_hours: z.coerce.number().int().min(0).max(24 * 60),
  max_bookings_per_day: z.coerce.number().int().min(1).max(100).nullable(),
  working_hours: z.partialRecord(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
    z.array(z.tuple([z.string().regex(HHMM), z.string().regex(HHMM)])).max(3)),
  staff_alert_phones: z.array(z.string().regex(/^\+?\d{10,15}$/, 'Use a phone number like 919392534625')).max(10),
  upi_vpa: z.string().trim().regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, 'Use a UPI id like balloonsbuzz@okhdfc').nullable(),
  upi_payee_name: z.string().trim().max(100).nullable(),
}).partial().strict()
  .refine((b) => !(b.advance_type === 'percent' && b.advance_value > 100), { message: 'A percentage advance cannot exceed 100', path: ['advance_value'] });

const BUSINESS_COLS = `id, business_name, base_address, advance_type, advance_value, min_lead_time_hours, max_bookings_per_day,
  working_hours, staff_alert_phones, upi_vpa, upi_payee_name, updated_at`;

router.get('/business', read, ah(async (req, res) => {
  const { rows: [b] } = await query(`SELECT ${BUSINESS_COLS} FROM business_settings WHERE tenant_id = $1`, [req.user.tenantId]);
  res.json({ business: b || null });
}));

router.put('/business', write, ah(async (req, res) => {
  const patch = parse(businessSchema, req.body);
  if (patch.staff_alert_phones) patch.staff_alert_phones = patch.staff_alert_phones.map((p) => p.replace(/^\+/, ''));
  const { rows: [before] } = await query(`SELECT ${BUSINESS_COLS} FROM business_settings WHERE tenant_id = $1`, [req.user.tenantId]);
  if (!before) return res.status(404).json({ error: 'Business settings missing' });
  const fields = Object.keys(patch);
  if (!fields.length) return res.json({ business: before });
  const { rows: [after] } = await query(
    `UPDATE business_settings SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE tenant_id = $1 RETURNING ${BUSINESS_COLS}`,
    [req.user.tenantId, ...fields.map((f) => (f === 'working_hours' ? JSON.stringify(patch[f]) : patch[f]))]);
  await audit.fromReq(req, { action: 'business_settings.update', entityType: 'business_settings', entityId: after.id, before, after });
  return res.json({ business: after });
}));

module.exports = router;
