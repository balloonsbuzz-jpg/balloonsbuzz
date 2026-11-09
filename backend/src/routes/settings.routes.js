const express = require('express');
const { z } = require('zod');
const { query } = require('../db/pool');
const { ah, parse } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
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

router.post('/whatsapp/health', write, ah(async (req, res) => res.json(await accounts.healthCheck(req))));

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
router.post('/whatsapp/test-message', write, ah(async (req, res) => {
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

module.exports = router;
