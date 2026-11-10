// Automations: the worker checks every minute which follow-ups are due and creates
// them. Each follow-up has an idempotency key (e.g. "event_reminder:<booking>"), so a
// reminder is created once per booking no matter how often the check runs.
const { query } = require('../db/pool');
const { badRequest, notFound } = require('../lib/errors');
const { enqueue } = require('../queue/jobs');
const logger = require('../lib/logger');
const render = require('../templates/render');

/** Fallback texts (sent only inside the 24-hour window when no approved template exists). */
const FALLBACK = {
  advance_reminder: (v) => `Hi ${v['contact.first_name']} 🙏 A gentle reminder: the advance of ${v['booking.advance_due']} for booking ${v['booking.code']} (${v['booking.event_date']}) is pending.`
    + `${v['payment.upi_id'] ? ` UPI: ${v['payment.upi_id']}.` : ''} Please share the payment screenshot here to confirm your date.`,
  event_reminder: (v) => `Hi ${v['contact.first_name']}! 🎈 Our team will be at ${v['booking.venue']} on ${v['booking.event_date']}${v['booking.event_time'] ? ` at ${v['booking.event_time']}` : ''} to set up. Balance on the day: ${v['booking.balance']}. Reply here if anything has changed.`,
  review_request: (v) => `Hi ${v['contact.first_name']}, thank you for celebrating with BalloonsBuzz 🎉 We hope you loved it! Could you share a photo or a quick review? It means a lot to us 💕`,
};

/** "Hi {{contact.first_name}}" style placeholders in admin-written texts. */
function fillText(text, vals) {
  return String(text || '').replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (all, k) => (vals[k] != null ? vals[k] : all));
}

async function list(tenantId) {
  const { rows } = await query(
    `SELECT a.*, (SELECT count(*)::int FROM followups f WHERE f.automation_id = a.id AND f.status = 'sent') AS sent_count,
            (SELECT count(*)::int FROM followups f WHERE f.automation_id = a.id AND f.status = 'pending') AS pending_count
       FROM automations a WHERE a.tenant_id = $1 ORDER BY a.created_at, a.key`, [tenantId]);
  return rows;
}

const CONFIG_RULES = {
  quote_no_reply: { trigger: ['delay_minutes'], action: ['text'] },
  advance_pending: { trigger: ['delay_minutes'] },
  event_reminder: { trigger: ['offset_hours'] },
  post_event_review: { trigger: ['offset_hours'] },
  lead_stale: { trigger: ['delay_minutes'] },
  booking_confirmed: {},
  handover_requested: {},
};

async function update(tenantId, id, patch) {
  const { rows: [a] } = await query(`SELECT * FROM automations WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!a) throw notFound('Automation not found');
  const rules = CONFIG_RULES[a.trigger_type] || {};
  const trig = { ...a.trigger_config };
  const act = { ...a.action_config };
  for (const [k, v] of Object.entries(patch.trigger_config || {})) {
    if (!(rules.trigger || []).includes(k)) throw badRequest(`"${k}" can’t be changed here`);
    const n = Number(v);
    if (k === 'delay_minutes' && !(n >= 10 && n <= 60 * 24 * 30)) throw badRequest('Delay must be 10 minutes to 30 days');
    if (k === 'offset_hours' && !(Math.abs(n) >= 1 && Math.abs(n) <= 24 * 14)) throw badRequest('Offset must be 1 hour to 14 days');
    trig[k] = n;
  }
  for (const [k, v] of Object.entries(patch.action_config || {})) {
    if (!(rules.action || []).includes(k)) throw badRequest(`"${k}" can’t be changed here`);
    if (k === 'text' && !(String(v).trim().length >= 5 && String(v).length <= 600)) throw badRequest('Message must be 5–600 characters');
    if (k === 'text' && /₹|\brs\.?\s*\d|\d+\s*k\b/i.test(String(v))) throw badRequest('Automatic texts can’t contain prices');
    act[k] = String(v).trim();
  }
  const { rows: [r] } = await query(
    `UPDATE automations SET is_active = COALESCE($3, is_active), trigger_config = $4, action_config = $5 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, patch.is_active ?? null, JSON.stringify(trig), JSON.stringify(act)]);
  return { before: a, after: r };
}

/** Inserts a follow-up unless one with the same key exists, then queues it. Returns true when new. */
async function createFollowup(f) {
  const { rows: [row] } = await query(
    `INSERT INTO followups (tenant_id, contact_id, conversation_id, lead_id, booking_id, automation_id, kind, idempotency_key, scheduled_at, content, cancel_on_reply)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, now()),$10,$11)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id, scheduled_at`,
    [f.tenantId, f.contactId, f.conversationId || null, f.leadId || null, f.bookingId || null, f.automationId, f.kind, f.key,
      f.scheduledAt || null, JSON.stringify(f.content), f.cancelOnReply ?? false]);
  if (!row) return false;
  await enqueue({ tenantId: f.tenantId, name: 'send_followup', payload: { followup_id: row.id }, runAt: row.scheduled_at, uniqueKey: `followup:${row.id}` });
  return true;
}

// Event time in IST (time unknown -> 10:00), as a SQL expression.
const EVENT_AT = `((b.event_date + COALESCE(b.event_time, '10:00')) AT TIME ZONE 'Asia/Kolkata')`;

const RUNNERS = {
  async quote_no_reply(a) {
    const delay = Number(a.trigger_config.delay_minutes || 180);
    const { rows } = await query(
      `SELECT DISTINCT ON (q.conversation_id) q.id, q.lead_id, q.conversation_id, cv.contact_id, ct.name
         FROM quotes q JOIN conversations cv ON cv.id = q.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
        WHERE q.tenant_id = $1 AND q.status IN ('issued','negotiating') AND NOT cv.is_sandbox
          AND q.created_at <= now() - make_interval(mins => $2) AND q.created_at > now() - make_interval(mins => $2) - interval '2 days'
          AND cv.last_inbound_at > now() - interval '23 hours'
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = q.conversation_id AND m.direction = 'inbound' AND m.created_at > q.created_at)
          AND ($3 = false OR cv.handling_mode = 'bot')
        ORDER BY q.conversation_id, q.created_at DESC`, [a.tenant_id, delay, a.only_when_bot]);
    let n = 0;
    for (const q of rows) {
      const text = fillText(a.action_config.text, render.values({ contact: { name: q.name } }));
      if (await createFollowup({
        tenantId: a.tenant_id, contactId: q.contact_id, conversationId: q.conversation_id, leadId: q.lead_id, automationId: a.id,
        kind: 'quote_no_reply', key: `quote_nudge:${q.id}`, content: { type: 'text', text, only_when_bot: a.only_when_bot }, cancelOnReply: true,
      })) n += 1;
    }
    return n;
  },

  async advance_pending(a) {
    const delay = Number(a.trigger_config.delay_minutes || 720);
    const { rows } = await query(
      `SELECT b.id, b.contact_id, b.lead_id FROM bookings b JOIN contacts ct ON ct.id = b.contact_id
        WHERE b.tenant_id = $1 AND b.status = 'advance_pending' AND b.advance_status IN ('pending','partial') AND b.advance_amount > 0
          AND b.created_at <= now() - make_interval(mins => $2) AND ${EVENT_AT} > now() AND b.deleted_at IS NULL AND ct.source <> 'sandbox'`,
      [a.tenant_id, delay]);
    let n = 0;
    for (const b of rows) {
      if (await createFollowup({ tenantId: a.tenant_id, contactId: b.contact_id, leadId: b.lead_id, bookingId: b.id, automationId: a.id,
        kind: 'advance_pending', key: `advance_reminder:${b.id}`, content: { type: 'booking', purpose: 'advance_reminder' } })) n += 1;
    }
    return n;
  },

  async event_reminder(a) {
    const hours = Math.abs(Number(a.trigger_config.offset_hours || -24));
    const { rows } = await query(
      `SELECT b.id, b.contact_id, b.lead_id FROM bookings b JOIN contacts ct ON ct.id = b.contact_id
        WHERE b.tenant_id = $1 AND b.status = 'confirmed' AND b.deleted_at IS NULL AND ct.source <> 'sandbox'
          AND ${EVENT_AT} > now() AND ${EVENT_AT} <= now() + make_interval(hours => $2)`, [a.tenant_id, hours]);
    let n = 0;
    for (const b of rows) {
      if (await createFollowup({ tenantId: a.tenant_id, contactId: b.contact_id, leadId: b.lead_id, bookingId: b.id, automationId: a.id,
        kind: 'event_reminder', key: `event_reminder:${b.id}`, content: { type: 'booking', purpose: 'event_reminder' } })) n += 1;
    }
    return n;
  },

  async post_event_review(a) {
    const hours = Math.abs(Number(a.trigger_config.offset_hours || 24));
    const { rows } = await query(
      `SELECT b.id, b.contact_id, b.lead_id FROM bookings b JOIN contacts ct ON ct.id = b.contact_id
        WHERE b.tenant_id = $1 AND b.status IN ('confirmed','completed') AND b.deleted_at IS NULL AND ct.source <> 'sandbox' AND ct.opted_in
          AND ${EVENT_AT} + make_interval(hours => $2) <= now() AND ${EVENT_AT} + make_interval(hours => $2) > now() - interval '3 days'`,
      [a.tenant_id, hours]);
    let n = 0;
    for (const b of rows) {
      if (await createFollowup({ tenantId: a.tenant_id, contactId: b.contact_id, leadId: b.lead_id, bookingId: b.id, automationId: a.id,
        kind: 'post_event_review', key: `review_request:${b.id}`, content: { type: 'booking', purpose: 'review_request' } })) n += 1;
    }
    return n;
  },

  async lead_stale(a) {
    const delay = Number(a.trigger_config.delay_minutes || 2880);
    const { rowCount } = await query(
      `UPDATE leads l SET status = 'stale'
         FROM conversations cv
        WHERE l.tenant_id = $1 AND cv.id = l.conversation_id AND l.status IN ('new','qualifying','quoted','negotiating')
          AND l.deleted_at IS NULL AND l.last_activity_at < now() - make_interval(mins => $2)
          AND ($3 = false OR cv.handling_mode = 'bot')`, [a.tenant_id, delay, a.only_when_bot]);
    return rowCount;
  },
};

/** Runs every active automation (all tenants). Safe to call as often as you like. */
async function runDue({ tenantId = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM automations WHERE is_active AND ($1::uuid IS NULL OR tenant_id = $1) ORDER BY tenant_id, key`, [tenantId]);
  const result = {};
  for (const a of rows) {
    const run = RUNNERS[a.trigger_type];
    if (!run) continue;
    try {
      const n = await run(a);
      result[a.key] = n;
      if (n) await query(`UPDATE automations SET run_count = run_count + $2, last_run_at = now() WHERE id = $1`, [a.id, n]);
    } catch (err) {
      logger.error('automation failed', { key: a.key, error: err.message });
      result[a.key] = `error: ${err.message}`;
    }
  }
  return result;
}

async function followups(tenantId, { status = 'pending', limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT f.id, f.kind, f.status, f.scheduled_at, f.sent_at, f.cancelled_at, f.cancel_reason, f.error_message, f.content, f.conversation_id,
            ct.name AS contact_name, ct.phone AS contact_phone, b.booking_code, a.name AS automation_name
       FROM followups f JOIN contacts ct ON ct.id = f.contact_id
       LEFT JOIN bookings b ON b.id = f.booking_id LEFT JOIN automations a ON a.id = f.automation_id
      WHERE f.tenant_id = $1 AND ct.source <> 'sandbox' AND ($2 = 'all' OR f.status = $2)
      ORDER BY CASE WHEN f.status = 'pending' THEN f.scheduled_at END ASC, f.updated_at DESC LIMIT $3`, [tenantId, status, limit]);
  return rows;
}

async function cancelFollowup(tenantId, id, reason = 'Cancelled by the team') {
  const { rows: [f] } = await query(
    `UPDATE followups SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3 WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING id`,
    [id, tenantId, reason]);
  if (!f) throw badRequest('Only pending follow-ups can be cancelled');
}

/**
 * Job: a chat was handed to a person -> message the team's alert phones (approved
 * "handover_alert" template; staff phones are set in Settings → Business).
 */
async function staffAlertJob({ conversation_id: conversationId, reason }) {
  const { rows: [a] } = await query(
    `SELECT a.is_active, a.id FROM automations a JOIN conversations cv ON cv.tenant_id = a.tenant_id
      WHERE cv.id = $1 AND a.trigger_type = 'handover_requested' AND NOT cv.is_sandbox`, [conversationId]);
  if (!a?.is_active) return { sent: 0 };
  const { rows: [cv] } = await query(
    `SELECT cv.tenant_id, cv.whatsapp_account_id, ct.name, ct.phone, bs.staff_alert_phones
       FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id LEFT JOIN business_settings bs ON bs.tenant_id = cv.tenant_id
      WHERE cv.id = $1`, [conversationId]);
  const phones = (cv?.staff_alert_phones || []).filter((p) => p !== cv.phone);
  if (!phones.length) return { sent: 0 };
  // eslint-disable-next-line global-require
  const templates = require('../templates/templates.service');
  const { sendToPhone } = require('../whatsapp/outbound.service');
  const tpl = await templates.forPurpose(cv.tenant_id, 'handover_alert', cv.whatsapp_account_id);
  if (!tpl) { logger.info('staff alert skipped: no approved handover_alert template'); return { sent: 0 }; }
  const vals = render.values({ contact: { name: cv.name, phone: cv.phone }, handover: { reason } });
  const { content, missing } = render.buildContent(tpl, vals);
  if (missing.length) { logger.warn('staff alert template has unmapped fields', { missing }); return { sent: 0 }; }
  for (const phone of phones) {
    await sendToPhone({ tenantId: cv.tenant_id, phone, type: 'template', content: { ...content, preview_text: render.preview(tpl, vals) }, senderType: 'system' });
  }
  await query(`UPDATE automations SET run_count = run_count + 1, last_run_at = now() WHERE id = $1`, [a.id]);
  return { sent: phones.length };
}

module.exports = { list, update, runDue, followups, cancelFollowup, createFollowup, fillText, FALLBACK, RUNNERS, staffAlertJob };
