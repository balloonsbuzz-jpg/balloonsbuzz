// Inbox reads and agent actions on conversations.
const { query, withTx } = require('../db/pool');
const { notFound, badRequest } = require('../lib/errors');
const { enqueue } = require('../queue/jobs');
const { enqueueMessage } = require('../whatsapp/outbound.service');
const audit = require('../services/audit.service');
const bus = require('../realtime/bus');
const { switchMode } = require('./handover.service');

const FILTERS = {
  all: `cv.status <> 'closed'`,
  needs_human: `cv.needs_human AND cv.status <> 'closed'`,
  bot: `cv.handling_mode = 'bot' AND cv.status <> 'closed'`,
  human: `cv.handling_mode IN ('human','paused') AND cv.status <> 'closed'`,
  unread: `cv.unread_count > 0`,
  mine: `cv.assigned_user_id = $USER AND cv.status <> 'closed'`,
  closed: `cv.status = 'closed'`,
};

const LIST_COLS = `
  cv.id, cv.status, cv.handling_mode, cv.needs_human, cv.handover_reason, cv.handover_at, cv.bot_resume_at,
  cv.unread_count, cv.last_message_at, cv.last_message_preview, cv.last_message_direction, cv.last_inbound_at,
  (cv.last_inbound_at > now() - interval '24 hours') AS window_open,
  cv.last_inbound_at + interval '24 hours' AS window_expires_at,
  cv.assigned_user_id, au.full_name AS assigned_user_name,
  ct.id AS contact_id, ct.name AS contact_name, ct.phone AS contact_phone`;

async function list(tenantId, userId, { filter = 'all', search, limit = 30, cursor } = {}) {
  if (!FILTERS[filter]) throw badRequest(`Unknown filter: ${filter}`);
  const params = [tenantId];
  const where = [`cv.tenant_id = $1`, `NOT cv.is_sandbox`, FILTERS[filter].replace('$USER', () => { params.push(userId); return `$${params.length}`; })];
  if (search) {
    const digits = search.replace(/\D/g, '');
    params.push(`%${search.trim().toLowerCase()}%`);
    const nameIdx = params.length;
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      where.push(`(lower(ct.name) LIKE $${nameIdx} OR ct.phone LIKE $${params.length})`);
    } else where.push(`lower(ct.name) LIKE $${nameIdx}`);
  }
  if (cursor) {
    const [at, id] = String(cursor).split('|');
    params.push(at, id);
    where.push(`(COALESCE(cv.last_message_at, cv.created_at), cv.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(Math.min(Number(limit) || 30, 100));
  const { rows } = await query(
    `SELECT ${LIST_COLS}, COALESCE(cv.last_message_at, cv.created_at) AS sort_at
       FROM conversations cv
       JOIN contacts ct ON ct.id = cv.contact_id
       LEFT JOIN users au ON au.id = cv.assigned_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY sort_at DESC, cv.id DESC
      LIMIT $${params.length}`, params);
  const last = rows[rows.length - 1];
  return {
    conversations: rows.map(({ sort_at: _s, ...r }) => r),
    next_cursor: rows.length === params[params.length - 1] && last ? `${new Date(last.sort_at).toISOString()}|${last.id}` : null,
  };
}

async function counts(tenantId, userId) {
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE needs_human AND status <> 'closed')::int AS needs_human,
            count(*) FILTER (WHERE unread_count > 0)::int AS unread,
            count(*) FILTER (WHERE assigned_user_id = $2 AND status <> 'closed')::int AS mine,
            count(*) FILTER (WHERE status <> 'closed')::int AS open
       FROM conversations WHERE tenant_id = $1 AND NOT is_sandbox`, [tenantId, userId]);
  return rows[0];
}

async function get(tenantId, id) {
  const { rows } = await query(
    `SELECT ${LIST_COLS}, ct.email AS contact_email, ct.source AS contact_source, ct.created_at AS contact_since, ct.opted_in AS contact_opted_in
       FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id LEFT JOIN users au ON au.id = cv.assigned_user_id
      WHERE cv.id = $1 AND cv.tenant_id = $2`, [id, tenantId]);
  if (!rows[0]) throw notFound('Conversation not found');
  const { rows: history } = await query(
    `SELECT h.from_mode, h.to_mode, h.trigger, h.reason, h.created_at, u.full_name AS actor_name
       FROM handover_events h LEFT JOIN users u ON u.id = h.actor_user_id
      WHERE h.conversation_id = $1 ORDER BY h.created_at DESC LIMIT 20`, [id]);
  // What we know about the event (the open lead, or the latest one) and this customer's bookings.
  const [{ rows: [lead] }, { rows: bookings }] = await Promise.all([
    query(`SELECT l.id, l.status, l.event_date, l.event_time, l.venue_address, l.distance_km, l.distance_charge, l.guest_count,
                  l.budget_min, l.budget_max, l.theme_text, o.name AS occasion_name, t.name AS theme_name, p.name AS package_name,
                  (SELECT q.id FROM quotes q WHERE q.lead_id = l.id AND q.status IN ('issued','negotiating','accepted') ORDER BY q.created_at DESC LIMIT 1) AS latest_quote_id,
                  (SELECT q.final_price FROM quotes q WHERE q.lead_id = l.id AND q.status IN ('issued','negotiating','accepted') ORDER BY q.created_at DESC LIMIT 1) AS latest_price
             FROM leads l LEFT JOIN occasions o ON o.id = l.occasion_id LEFT JOIN themes t ON t.id = l.theme_id LEFT JOIN packages p ON p.id = l.package_id
            WHERE l.conversation_id = $1 AND l.deleted_at IS NULL ORDER BY (l.status NOT IN ('won','lost')) DESC, l.created_at DESC LIMIT 1`, [id]),
    query(`SELECT id, booking_code, status, event_date, agreed_price, advance_status FROM bookings
            WHERE contact_id = $1 AND deleted_at IS NULL ORDER BY event_date DESC LIMIT 5`, [rows[0].contact_id]),
  ]);
  return { ...rows[0], handover_history: history, lead: lead || null, bookings };
}

async function messages(tenantId, conversationId, { before, limit = 50 } = {}) {
  const params = [conversationId, tenantId];
  let cond = '';
  if (before) { params.push(before); cond = `AND m.created_at < $${params.length}`; }
  params.push(Math.min(Number(limit) || 50, 200));
  const { rows } = await query(
    `SELECT m.id, m.direction, m.sender_type, u.full_name AS sender_name, m.message_type, m.body, m.payload,
            m.media_id, md.mime_type AS media_mime_type, md.original_filename AS media_filename,
            m.gallery_item_id, m.wa_message_id, m.status, m.error_code, m.error_message, m.is_internal_note,
            m.reply_to_message_id, r.body AS reply_to_body, r.direction AS reply_to_direction, r.message_type AS reply_to_type,
            m.sent_at, m.delivered_at, m.read_at, m.created_at
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       LEFT JOIN media md ON md.id = m.media_id
       LEFT JOIN messages r ON r.id = m.reply_to_message_id
      WHERE m.conversation_id = $1 AND m.tenant_id = $2 ${cond}
      ORDER BY m.created_at DESC LIMIT $${params.length}`, params);
  // the send payload is internal; expose only what the UI renders
  return rows.reverse().map((m) => ({ ...m, payload: m.payload?.send ? { send_type: m.payload.send.type } : m.payload }));
}

/** Agent reply. Replying while the bot is active takes the chat over (bot goes quiet). */
async function agentSend(req, conversationId, { text, reply_to_message_id: replyTo }) {
  return withTx(async (c) => {
    await switchMode(c, { tenantId: req.user.tenantId, conversationId, to: 'human', trigger: 'agent_reply', actorUserId: req.user.id, reason: 'Agent replied' });
    const msg = await enqueueMessage({
      tenantId: req.user.tenantId, conversationId, type: 'text', content: { text },
      senderType: 'agent', senderUserId: req.user.id, replyToMessageId: replyTo || null,
    }, c);
    return msg;
  });
}

async function addNote(req, conversationId, text) {
  return withTx(async (c) => {
    const { rows } = await c.query(`SELECT contact_id FROM conversations WHERE id = $1 AND tenant_id = $2`, [conversationId, req.user.tenantId]);
    if (!rows[0]) throw notFound('Conversation not found');
    const { rows: [note] } = await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, sender_user_id, message_type, body, status, is_internal_note)
       VALUES ($1,$2,$3,'outbound','agent',$4,'text',$5,'sent',true) RETURNING id, created_at`,
      [req.user.tenantId, conversationId, rows[0].contact_id, req.user.id, text]);
    await bus.publish({ tenantId: req.user.tenantId, type: 'message.new', conversation_id: conversationId, message_id: note.id }, c);
    return note;
  });
}

/** Clears unread and (if enabled) sends WhatsApp blue ticks for the latest customer message. */
async function markRead(req, conversationId) {
  return withTx(async (c) => {
    const { rows } = await c.query(
      `UPDATE conversations cv SET unread_count = 0 FROM whatsapp_accounts wa
        WHERE cv.id = $1 AND cv.tenant_id = $2 AND wa.id = cv.whatsapp_account_id
        RETURNING cv.id, wa.read_receipts_enabled`, [conversationId, req.user.tenantId]);
    if (!rows[0]) throw notFound('Conversation not found');
    if (rows[0].read_receipts_enabled) {
      const { rows: [last] } = await c.query(
        `SELECT id, wa_message_id FROM messages WHERE conversation_id = $1 AND direction = 'inbound' AND wa_message_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`, [conversationId]);
      if (last) {
        await enqueue({ tenantId: req.user.tenantId, name: 'mark_read', payload: { message_id: last.id }, uniqueKey: `mark_read:${last.id}`, maxAttempts: 3 }, c);
      }
    }
    await bus.publish({ tenantId: req.user.tenantId, type: 'conversation.updated', conversation_id: conversationId }, c);
    return { ok: true };
  });
}

async function assign(req, conversationId, userId) {
  return withTx(async (c) => {
    if (userId) {
      const { rows } = await c.query(`SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND is_active AND deleted_at IS NULL`, [userId, req.user.tenantId]);
      if (!rows[0]) throw badRequest('That user cannot be assigned');
    }
    const { rows } = await c.query(
      `UPDATE conversations SET assigned_user_id = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id, assigned_user_id`,
      [conversationId, req.user.tenantId, userId || null]);
    if (!rows[0]) throw notFound('Conversation not found');
    await audit.fromReq(req, { action: 'conversation.assign', entityType: 'conversation', entityId: conversationId, after: { assigned_user_id: userId || null } }, c);
    await bus.publish({ tenantId: req.user.tenantId, type: 'conversation.updated', conversation_id: conversationId }, c);
    return rows[0];
  });
}

async function setStatus(req, conversationId, status) {
  return withTx(async (c) => {
    const { rows } = await c.query(
      `UPDATE conversations SET status = $3, needs_human = CASE WHEN $3 = 'closed' THEN false ELSE needs_human END
        WHERE id = $1 AND tenant_id = $2 RETURNING id, status`, [conversationId, req.user.tenantId, status]);
    if (!rows[0]) throw notFound('Conversation not found');
    await audit.fromReq(req, { action: `conversation.${status === 'closed' ? 'close' : 'reopen'}`, entityType: 'conversation', entityId: conversationId }, c);
    await bus.publish({ tenantId: req.user.tenantId, type: 'conversation.updated', conversation_id: conversationId }, c);
    return rows[0];
  });
}

module.exports = { list, counts, get, messages, agentSend, addNote, markRead, assign, setStatus, FILTERS };
