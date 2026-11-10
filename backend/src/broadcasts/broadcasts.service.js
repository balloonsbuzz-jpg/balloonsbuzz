// Broadcasts: one approved template to a segment of customers.
//
//   draft -> scheduled -> (broadcast_start job) running -> completed
//                                     ↕ paused          ↘ cancelled
//
// Recipients are created when it starts and sent in small batches through the normal
// send queue (retries, rate limits). Opted-out customers are never messaged: they are
// excluded from the audience and re-checked right before each send.
const { query, withTx } = require('../db/pool');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { enqueue } = require('../queue/jobs');
const { enqueueMessage } = require('../whatsapp/outbound.service');
const bus = require('../realtime/bus');
const audit = require('../services/audit.service');
const render = require('../templates/render');

const BATCH = 25;
const BATCH_GAP_MS = 1500;      // ~16 messages/second at most, well under WhatsApp's limits
const REPLY_WINDOW_HOURS = 72;

// ── audience ────────────────────────────────────────────────────
/**
 * filter: { tags_any?: uuid[], lead_status?: string[], occasion_ids?: uuid[],
 *           booked?: 'any'|'yes'|'no', active_within_days?: number }
 */
function audienceWhere(tenantId, f = {}) {
  const params = [tenantId];
  const where = [
    'ct.tenant_id = $1', 'ct.deleted_at IS NULL', `ct.source <> 'sandbox'`, 'ct.opted_in',
  ];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (f.tags_any?.length) where.push(`EXISTS (SELECT 1 FROM contact_tags x WHERE x.contact_id = ct.id AND x.tag_id = ANY(${p(f.tags_any)}::uuid[]))`);
  if (f.lead_status?.length) where.push(`EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = ct.id AND l.deleted_at IS NULL AND l.status = ANY(${p(f.lead_status)}::text[]))`);
  if (f.occasion_ids?.length) where.push(`EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = ct.id AND l.deleted_at IS NULL AND l.occasion_id = ANY(${p(f.occasion_ids)}::uuid[]))`);
  if (f.booked === 'yes') where.push(`EXISTS (SELECT 1 FROM bookings b WHERE b.contact_id = ct.id AND b.status IN ('confirmed','completed') AND b.deleted_at IS NULL)`);
  if (f.booked === 'no') where.push(`NOT EXISTS (SELECT 1 FROM bookings b WHERE b.contact_id = ct.id AND b.status <> 'cancelled' AND b.deleted_at IS NULL)`);
  if (f.active_within_days) where.push(`ct.last_inbound_at > now() - make_interval(days => ${p(f.active_within_days)})`);
  return { where: where.join(' AND '), params };
}

async function preview(tenantId, filter) {
  const { where, params } = audienceWhere(tenantId, filter);
  const optedOut = audienceWhere(tenantId, filter);
  const [{ rows: [c] }, { rows: sample }, { rows: [o] }] = await Promise.all([
    query(`SELECT count(*)::int AS n FROM contacts ct WHERE ${where}`, params),
    query(`SELECT ct.name, ct.phone FROM contacts ct WHERE ${where} ORDER BY ct.last_inbound_at DESC NULLS LAST LIMIT 5`, params),
    query(`SELECT count(*)::int AS n FROM contacts ct WHERE ${optedOut.where.replace(' AND ct.opted_in', ' AND NOT ct.opted_in')}`, optedOut.params),
  ]);
  return { count: c.n, opted_out_excluded: o.n, sample };
}

// ── CRUD ────────────────────────────────────────────────────────
const SELECT = `SELECT b.*, t.name AS template_name, t.language AS template_language, t.status AS template_status, t.category AS template_category,
                       t.components AS template_components, t.variable_map AS template_variable_map, u.full_name AS created_by_name
                  FROM broadcasts b JOIN templates t ON t.id = b.template_id LEFT JOIN users u ON u.id = b.created_by`;

async function list(tenantId) {
  const { rows } = await query(`${SELECT} WHERE b.tenant_id = $1 AND b.deleted_at IS NULL ORDER BY b.created_at DESC LIMIT 100`, [tenantId]);
  return rows;
}

async function get(tenantId, id) {
  const { rows: [b] } = await query(`${SELECT} WHERE b.id = $1 AND b.tenant_id = $2 AND b.deleted_at IS NULL`, [id, tenantId]);
  if (!b) throw notFound('Broadcast not found');
  return b;
}

async function recipients(tenantId, id, { status, limit = 100, offset = 0 } = {}) {
  await get(tenantId, id);
  const { rows } = await query(
    `SELECT r.id, r.phone, r.status, r.error_message, r.attempts, r.sent_at, r.delivered_at, r.read_at, r.replied_at, ct.name AS contact_name
       FROM broadcast_recipients r LEFT JOIN contacts ct ON ct.id = r.contact_id
      WHERE r.broadcast_id = $1 AND ($2::text IS NULL OR r.status = $2 OR ($2 = 'replied' AND r.replied_at IS NOT NULL))
      ORDER BY r.created_at, r.phone LIMIT $3 OFFSET $4`, [id, status || null, limit, offset]);
  return rows;
}

async function validTemplate(tenantId, templateId, statics) {
  const { rows: [t] } = await query(`SELECT * FROM templates WHERE id = $1 AND tenant_id = $2`, [templateId, tenantId]);
  if (!t) throw badRequest('Unknown template');
  if (t.status !== 'approved') throw badRequest('Only templates approved by Meta can be broadcast');
  const map = t.variable_map || {};
  const problems = [];
  for (const n of render.placeholders(t.components)) {
    const key = map[String(n)];
    if (!key) problems.push(`{{${n}}} is not mapped (Templates page)`);
    else if (key.startsWith('booking.')) problems.push(`{{${n}}} uses a booking field, which a broadcast can't fill`);
    else if (key === 'static' && !String(statics?.[String(n)] || '').trim()) problems.push(`type the text for {{${n}}}`);
  }
  if (problems.length) throw badRequest(`Template not ready: ${problems.join('; ')}`);
  return t;
}

async function create(req, b) {
  const t = await validTemplate(req.user.tenantId, b.template_id, b.variables);
  const { rows: [row] } = await query(
    `INSERT INTO broadcasts (tenant_id, whatsapp_account_id, template_id, name, variables, audience_filter, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.user.tenantId, t.whatsapp_account_id, t.id, b.name, JSON.stringify(b.variables || {}), JSON.stringify(b.audience_filter || {}), req.user.id]);
  await audit.fromReq(req, { action: 'broadcast.create', entityType: 'broadcast', entityId: row.id, after: { name: b.name, template: t.name } });
  return get(req.user.tenantId, row.id);
}

async function update(req, id, b) {
  const cur = await get(req.user.tenantId, id);
  if (!['draft', 'scheduled'].includes(cur.status)) throw conflict('Only drafts and scheduled broadcasts can be edited');
  const templateId = b.template_id || cur.template_id;
  const vars = b.variables || cur.variables;
  await validTemplate(req.user.tenantId, templateId, vars);
  await query(
    `UPDATE broadcasts SET name = COALESCE($2, name), template_id = $3, variables = $4, audience_filter = COALESCE($5, audience_filter) WHERE id = $1`,
    [id, b.name || null, templateId, JSON.stringify(vars), b.audience_filter ? JSON.stringify(b.audience_filter) : null]);
  return get(req.user.tenantId, id);
}

async function remove(req, id) {
  const cur = await get(req.user.tenantId, id);
  if (!['draft', 'scheduled', 'cancelled', 'completed'].includes(cur.status)) throw conflict('Pause or cancel it first');
  await query(`UPDATE broadcasts SET deleted_at = now(), status = CASE WHEN status = 'scheduled' THEN 'cancelled' ELSE status END WHERE id = $1`, [id]);
  await audit.fromReq(req, { action: 'broadcast.delete', entityType: 'broadcast', entityId: id });
}

// ── lifecycle ───────────────────────────────────────────────────
async function schedule(req, id, { at }) {
  const cur = await get(req.user.tenantId, id);
  if (!['draft', 'scheduled'].includes(cur.status)) throw conflict(`This broadcast is ${cur.status}`);
  await validTemplate(req.user.tenantId, cur.template_id, cur.variables);
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) throw badRequest('Invalid time');
  if (at && when.getTime() < Date.now() - 60_000) throw badRequest('That time is in the past');
  const { count } = await preview(req.user.tenantId, cur.audience_filter);
  if (!count) throw badRequest('Nobody matches this audience');
  await withTx(async (c) => {
    await c.query(`UPDATE broadcasts SET status = 'scheduled', scheduled_at = $2 WHERE id = $1`, [id, when]);
    await enqueue({ tenantId: req.user.tenantId, name: 'broadcast_start', payload: { broadcast_id: id }, runAt: when,
      uniqueKey: `broadcast_start:${id}:${when.getTime()}`, maxAttempts: 3 }, c);
    await audit.fromReq(req, { action: 'broadcast.schedule', entityType: 'broadcast', entityId: id, after: { scheduled_at: when, audience: count } }, c);
  });
  return get(req.user.tenantId, id);
}

/** Job: freeze the audience into recipients and start sending. */
async function startJob({ broadcast_id: id }) {
  const { rows: [b] } = await query(`SELECT * FROM broadcasts WHERE id = $1`, [id]);
  if (!b || b.status !== 'scheduled' || b.deleted_at) return;
  if (b.scheduled_at && new Date(b.scheduled_at).getTime() > Date.now() + 5000) return;   // rescheduled later; that job will start it
  const { where, params } = audienceWhere(b.tenant_id, b.audience_filter);
  await withTx(async (c) => {
    params.push(b.tenant_id, id);
    await c.query(
      `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, phone)
       SELECT $${params.length - 1}, $${params.length}, ct.id, ct.phone FROM contacts ct WHERE ${where}
       ON CONFLICT (broadcast_id, phone) DO NOTHING`, params);
    await c.query(`UPDATE broadcasts SET status = 'running', started_at = now() WHERE id = $1`, [id]);
  });
  await refreshCounts(id);
  await enqueue({ tenantId: b.tenant_id, name: 'broadcast_batch', payload: { broadcast_id: id }, uniqueKey: `broadcast_batch:${id}` });
}

async function conversationFor(c, tenantId, contactId, accountId) {
  const { rows: [cv] } = await c.query(
    `INSERT INTO conversations (tenant_id, contact_id, whatsapp_account_id) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, contact_id, whatsapp_account_id) DO UPDATE SET updated_at = now() RETURNING id`, [tenantId, contactId, accountId]);
  return cv.id;
}

/** Job: send the next batch, then queue the next one. */
async function batchJob({ broadcast_id: id }) {
  const { rows: [b] } = await query(
    `SELECT b.*, t.name AS t_name, t.language AS t_language, t.components AS t_components, t.variable_map AS t_map, t.status AS t_status
       FROM broadcasts b JOIN templates t ON t.id = b.template_id WHERE b.id = $1`, [id]);
  if (!b || b.status !== 'running') return;
  if (b.t_status !== 'approved') {
    await query(`UPDATE broadcasts SET status = 'paused' WHERE id = $1`, [id]);
    await bus.publish({ tenantId: b.tenant_id, type: 'broadcast.updated', broadcast_id: id });
    return;
  }
  const tpl = { name: b.t_name, language: b.t_language, components: b.t_components, variable_map: b.t_map };
  const { rows: [biz] } = await query(`SELECT business_name, upi_vpa FROM business_settings WHERE tenant_id = $1`, [b.tenant_id]);

  const sent = await withTx(async (c) => {
    const { rows: batch } = await c.query(
      `SELECT r.id, r.contact_id, ct.name, ct.opted_in, ct.deleted_at
         FROM broadcast_recipients r LEFT JOIN contacts ct ON ct.id = r.contact_id
        WHERE r.broadcast_id = $1 AND r.status = 'pending' ORDER BY r.created_at LIMIT $2 FOR UPDATE OF r SKIP LOCKED`, [id, BATCH]);
    for (const r of batch) {
      if (!r.contact_id || !r.opted_in || r.deleted_at) {     // opted out since the audience was taken
        await c.query(`UPDATE broadcast_recipients SET status = 'skipped', error_message = 'Opted out' WHERE id = $1`, [r.id]);
        continue;
      }
      const vals = render.values({ contact: { name: r.name }, business: biz || {} });
      const { content } = render.buildContent(tpl, vals, b.variables);
      const conversationId = await conversationFor(c, b.tenant_id, r.contact_id, b.whatsapp_account_id);
      const msg = await enqueueMessage({
        tenantId: b.tenant_id, conversationId, type: 'template', senderType: 'system',
        content: { ...content, preview_text: render.preview(tpl, vals, b.variables) },
      }, c);
      await c.query(`UPDATE broadcast_recipients SET status = 'queued', message_id = $2, attempts = attempts + 1, error_message = NULL WHERE id = $1`, [r.id, msg.id]);
    }
    return batch.length;
  });
  await refreshCounts(id);
  if (sent === BATCH) {
    await enqueue({ tenantId: b.tenant_id, name: 'broadcast_batch', payload: { broadcast_id: id }, delayMs: BATCH_GAP_MS, uniqueKey: `broadcast_batch:${id}:${Date.now()}` });
  }
}

const RECIPIENT_STATUS = { queued: 'queued', sending: 'queued', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

/** Called when a template message's status changes (sent, delivered, read, failed, cancelled). */
async function syncFromMessage(messageId) {
  const { rows: [m] } = await query(
    `SELECT m.status, m.wa_message_id, m.sent_at, m.delivered_at, m.read_at, m.error_message, r.id AS rid, r.broadcast_id
       FROM messages m JOIN broadcast_recipients r ON r.message_id = m.id WHERE m.id = $1`, [messageId]);
  if (!m) return;
  if (m.status === 'cancelled') {
    // paused or cancelled before it went out
    await query(`UPDATE broadcast_recipients r SET status = CASE WHEN b.status = 'cancelled' THEN 'skipped' ELSE 'pending' END, message_id = NULL
                   FROM broadcasts b WHERE r.id = $1 AND b.id = r.broadcast_id AND r.status = 'queued'`, [m.rid]);
  } else {
    const st = RECIPIENT_STATUS[m.status];
    if (!st) return;
    await query(
      `UPDATE broadcast_recipients SET status = $2, wa_message_id = COALESCE($3, wa_message_id), sent_at = COALESCE($4, sent_at),
              delivered_at = COALESCE($5, delivered_at), read_at = COALESCE($6, read_at), error_message = CASE WHEN $2 = 'failed' THEN $7 ELSE NULL END
        WHERE id = $1`, [m.rid, st, m.wa_message_id, m.sent_at, m.delivered_at, m.read_at, m.error_message]);
  }
  await refreshCounts(m.broadcast_id);
}

/** A customer wrote back within 72h of a broadcast: count it as a reply. */
async function noteReply(contactId) {
  const { rows } = await query(
    `UPDATE broadcast_recipients SET replied_at = now()
      WHERE contact_id = $1 AND replied_at IS NULL AND sent_at > now() - make_interval(hours => $2) RETURNING broadcast_id`, [contactId, REPLY_WINDOW_HOURS]);
  for (const r of rows) await refreshCounts(r.broadcast_id);
}

async function refreshCounts(id) {
  const { rows: [b] } = await query(
    `WITH c AS (
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status IN ('sent','delivered','read'))::int AS sent,
              count(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered,
              count(*) FILTER (WHERE status = 'read')::int AS read,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
              count(*) FILTER (WHERE status IN ('pending','queued'))::int AS open
         FROM broadcast_recipients WHERE broadcast_id = $1)
     UPDATE broadcasts b SET total_count = c.total, sent_count = c.sent, delivered_count = c.delivered, read_count = c.read,
            failed_count = c.failed, skipped_count = c.skipped, replied_count = c.replied,
            status = CASE WHEN b.status = 'running' AND c.open = 0 THEN 'completed' ELSE b.status END,
            completed_at = CASE WHEN b.status = 'running' AND c.open = 0 THEN now() ELSE b.completed_at END
       FROM c WHERE b.id = $1 RETURNING b.tenant_id`, [id]);
  if (b) await bus.publish({ tenantId: b.tenant_id, type: 'broadcast.updated', broadcast_id: id });
}

/** Pause or cancel: anything not yet handed to Meta is held back. */
async function stopQueued(c, id) {
  await c.query(
    `UPDATE messages SET status = 'cancelled', error_message = 'Broadcast paused or cancelled'
      WHERE id IN (SELECT message_id FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'queued' AND message_id IS NOT NULL)
        AND status = 'queued'`, [id]);
}

async function pause(req, id) {
  const cur = await get(req.user.tenantId, id);
  if (cur.status !== 'running') throw conflict('Only a running broadcast can be paused');
  await withTx(async (c) => {
    await c.query(`UPDATE broadcasts SET status = 'paused' WHERE id = $1`, [id]);
    await stopQueued(c, id);
    await c.query(`UPDATE broadcast_recipients r SET status = 'pending', message_id = NULL FROM messages m
                    WHERE r.broadcast_id = $1 AND r.status = 'queued' AND m.id = r.message_id AND m.status = 'cancelled'`, [id]);
    await audit.fromReq(req, { action: 'broadcast.pause', entityType: 'broadcast', entityId: id }, c);
  });
  await refreshCounts(id);
  return get(req.user.tenantId, id);
}

async function resume(req, id) {
  const cur = await get(req.user.tenantId, id);
  if (cur.status !== 'paused') throw conflict('Only a paused broadcast can be resumed');
  await validTemplate(req.user.tenantId, cur.template_id, cur.variables);
  await query(`UPDATE broadcasts SET status = 'running' WHERE id = $1`, [id]);
  await enqueue({ tenantId: req.user.tenantId, name: 'broadcast_batch', payload: { broadcast_id: id }, uniqueKey: `broadcast_batch:${id}:${Date.now()}` });
  await audit.fromReq(req, { action: 'broadcast.resume', entityType: 'broadcast', entityId: id });
  return get(req.user.tenantId, id);
}

async function cancel(req, id) {
  const cur = await get(req.user.tenantId, id);
  if (!['scheduled', 'running', 'paused'].includes(cur.status)) throw conflict(`This broadcast is ${cur.status}`);
  await withTx(async (c) => {
    await c.query(`UPDATE broadcasts SET status = 'cancelled', completed_at = now() WHERE id = $1`, [id]);
    await stopQueued(c, id);
    await c.query(`UPDATE broadcast_recipients SET status = 'skipped', error_message = 'Broadcast cancelled' WHERE broadcast_id = $1 AND status IN ('pending','queued')
                     AND (message_id IS NULL OR message_id IN (SELECT id FROM messages WHERE status = 'cancelled'))`, [id]);
    await audit.fromReq(req, { action: 'broadcast.cancel', entityType: 'broadcast', entityId: id }, c);
  });
  await refreshCounts(id);
  return get(req.user.tenantId, id);
}

/** Try the failed ones again (e.g. after fixing a template or a temporary Meta problem). */
async function retryFailed(req, id) {
  const cur = await get(req.user.tenantId, id);
  if (!['completed', 'running', 'paused'].includes(cur.status)) throw conflict(`This broadcast is ${cur.status}`);
  const { rowCount } = await query(
    `UPDATE broadcast_recipients SET status = 'pending', message_id = NULL, error_message = NULL WHERE broadcast_id = $1 AND status = 'failed'`, [id]);
  if (!rowCount) throw badRequest('No failed messages to retry');
  await query(`UPDATE broadcasts SET status = 'running', completed_at = NULL WHERE id = $1`, [id]);
  await enqueue({ tenantId: req.user.tenantId, name: 'broadcast_batch', payload: { broadcast_id: id }, uniqueKey: `broadcast_batch:${id}:${Date.now()}` });
  await audit.fromReq(req, { action: 'broadcast.retry_failed', entityType: 'broadcast', entityId: id, after: { retried: rowCount } });
  await refreshCounts(id);
  return { broadcast: await get(req.user.tenantId, id), retried: rowCount };
}

module.exports = {
  audienceWhere, preview, list, get, recipients, create, update, remove, schedule, pause, resume, cancel, retryFailed,
  startJob, batchJob, syncFromMessage, noteReply, refreshCounts,
};
