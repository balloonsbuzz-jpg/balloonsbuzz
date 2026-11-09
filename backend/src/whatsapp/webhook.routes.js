// Meta WhatsApp webhook: verify signature on the raw body, store each event once
// (idempotent on event_key), enqueue its processing job, and ack fast.
const crypto = require('crypto');
const express = require('express');
const { env } = require('../config/env');
const { pool } = require('../db/pool');
const logger = require('../lib/logger');
const { splitEvents } = require('./parse');
const { routeByPhoneNumberId } = require('./account.service');

const router = express.Router();

function validSignature(raw, header, secret) {
  if (!header || !secret || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// GET: Meta's subscription challenge
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  logger.warn('webhook verification rejected', { mode });
  return res.sendStatus(403);
});

// POST: events. Raw body is required for the HMAC check.
router.post('/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!env.META_APP_SECRET) {
    logger.error('META_APP_SECRET not set: refusing webhook (fail closed)');
    return res.sendStatus(503);
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!validSignature(raw, req.get('x-hub-signature-256'), env.META_APP_SECRET)) {
    logger.warn('webhook signature invalid', { ip: req.ip });
    return res.sendStatus(403);
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  try {
    const events = splitEvents(body, raw.toString('utf8'));
    for (const ev of events) {
      const route = ev.phoneNumberId ? await routeByPhoneNumberId(ev.phoneNumberId) : null;
      const routable = !!route && ev.eventType !== 'unknown';
      // One round trip: insert the event (pre-linked to a job id); only if it was new
      // AND routable, insert that job. Replays hit ON CONFLICT and create nothing.
      await pool.query(
        `WITH ids AS (SELECT gen_random_uuid() AS job_id),
         e AS (
           INSERT INTO webhook_events (tenant_id, source, event_key, event_type, phone_number_id, payload, signature_valid, status, job_id)
           SELECT $1, 'whatsapp', $2, $3, $4, $5, true, $6, CASE WHEN $8 THEN ids.job_id END FROM ids
           ON CONFLICT (source, event_key) DO NOTHING
           RETURNING id, tenant_id, job_id
         )
         INSERT INTO jobs (id, tenant_id, name, payload, priority)
         SELECT e.job_id, e.tenant_id, 'process_webhook_event', jsonb_build_object('webhook_event_id', e.id), $7
           FROM e WHERE e.job_id IS NOT NULL`,
        [route?.tenantId || null, ev.eventKey, ev.eventType, ev.phoneNumberId, JSON.stringify(ev.data),
          routable ? 'queued' : 'ignored', ev.eventType === 'message' ? 10 : 5, routable]);
    }
    res.sendStatus(200);
  } catch (err) {
    // Not acking makes Meta retry later; idempotency keys make that safe.
    logger.error('webhook persist failed', { error: err.message });
    res.sendStatus(500);
  }
});

module.exports = { router, validSignature };
