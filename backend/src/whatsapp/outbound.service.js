// Outbound messages: stored as 'queued' + a send_message job in one transaction,
// then sent by the worker with retries. Enforces WhatsApp's 24-hour window.
const { query, withTx } = require('../db/pool');
const { conflict, notFound, badRequest } = require('../lib/errors');
const { normalizePhone } = require('../lib/phone');
const { enqueue, RetryableError, PermanentError } = require('../queue/jobs');
const { buildPayload, storedShape } = require('./payloads');
const { getForSending, getPrimary } = require('./account.service');
const { previewOf } = require('./parse');
const graph = require('./graph');
const logger = require('../lib/logger');
const bus = require('../realtime/bus');

const WINDOW_MS = 24 * 60 * 60 * 1000;

function insideWindow(lastInboundAt, now = Date.now()) {
  return !!lastInboundAt && now - new Date(lastInboundAt).getTime() < WINDOW_MS;
}

/**
 * Queue a message to an existing conversation.
 * @param {object} p { tenantId, conversationId, type, content, senderType:'bot'|'agent'|'system', senderUserId, replyToMessageId, aiRunId, galleryItemId }
 */
async function enqueueMessage(p, db) {
  const run = async (c) => {
    const { rows } = await c.query(
      `SELECT cv.id, cv.tenant_id, cv.contact_id, cv.last_inbound_at, ct.phone, ct.opted_in,
            (cv.last_inbound_at > now() - interval '24 hours') AS window_open
         FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
        WHERE cv.id = $1 AND cv.tenant_id = $2`, [p.conversationId, p.tenantId]);
    const conv = rows[0];
    if (!conv) throw notFound('Conversation not found');
    if (p.type !== 'template' && !conv.window_open) {   // computed by the DB clock
      throw conflict('The 24-hour reply window is closed: the customer has not messaged in the last 24 hours. Send an approved template instead.',
        { code: 'outside_24h_window', last_inbound_at: conv.last_inbound_at });
    }
    buildPayload(conv.phone, p.type, p.content);   // validate now; rebuilt at send time
    const shape = storedShape(p.type, p.content);
    const { rows: [msg] } = await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, sender_user_id, message_type,
                             body, payload, reply_to_message_id, status, ai_run_id, gallery_item_id)
       VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,$8,$9,'queued',$10,$11) RETURNING *`,
      [p.tenantId, conv.id, conv.contact_id, p.senderType, p.senderUserId || null, shape.message_type, shape.body,
        JSON.stringify({ send: { type: p.type, content: p.content } }), p.replyToMessageId || null, p.aiRunId || null, p.galleryItemId || null]);
    await c.query(
      `UPDATE conversations SET last_message_at = now(), last_message_preview = $2, last_message_direction = 'outbound' WHERE id = $1`,
      [conv.id, previewOf(shape)]);
    await enqueue({ tenantId: p.tenantId, name: 'send_message', payload: { message_id: msg.id }, priority: p.senderType === 'agent' ? 20 : 10, maxAttempts: 6 }, c);
    await bus.publish({ tenantId: p.tenantId, type: 'message.new', conversation_id: conv.id, message_id: msg.id }, c);
    return msg;
  };
  return db ? run(db) : withTx(run);
}

/**
 * Start (or reuse) a conversation with a phone number and queue a message.
 * Used by "send test message" and, later, broadcasts.
 */
async function sendToPhone({ tenantId, phone: rawPhone, type, content, senderType = 'agent', senderUserId }) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw badRequest('Invalid input', [{ field: 'phone', message: 'Enter a WhatsApp number with country code' }]);
  const account = await getPrimary(tenantId);
  if (!account) throw notFound('Connect a WhatsApp number in Settings first');
  return withTx(async (c) => {
    const { rows: [contact] } = await c.query(
      `INSERT INTO contacts (tenant_id, phone, source) VALUES ($1,$2,'manual')
       ON CONFLICT (tenant_id, phone) WHERE deleted_at IS NULL DO UPDATE SET updated_at = now() RETURNING id`, [tenantId, phone]);
    const { rows: [conv] } = await c.query(
      `INSERT INTO conversations (tenant_id, contact_id, whatsapp_account_id) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, contact_id, whatsapp_account_id) DO UPDATE SET updated_at = now() RETURNING id`,
      [tenantId, contact.id, account.id]);
    return enqueueMessage({ tenantId, conversationId: conv.id, type, content, senderType, senderUserId }, c);
  });
}

/** Worker handler for send_message jobs. */
async function sendMessageJob({ message_id: id }, job) {
  const { rows } = await query(
    `SELECT m.*, ct.phone, cv.whatsapp_account_id, r.wa_message_id AS reply_wamid
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN contacts ct ON ct.id = m.contact_id
       LEFT JOIN messages r ON r.id = m.reply_to_message_id
      WHERE m.id = $1`, [id]);
  const m = rows[0];
  if (!m) return;
  if (m.status !== 'queued' && m.status !== 'sending') return;   // cancelled, or already sent by a previous attempt

  const send = m.payload?.send;
  if (!send) throw new PermanentError('Message has no send payload');
  const account = await getForSending(m.whatsapp_account_id);
  const body = buildPayload(m.phone, send.type, send.content, m.reply_wamid || undefined);

  await query(`UPDATE messages SET status = 'sending', retry_count = retry_count + (CASE WHEN status = 'sending' THEN 1 ELSE 0 END) WHERE id = $1`, [id]);
  let res;
  try {
    res = await graph.sendMessage(account.phone_number_id, body, account.token);
  } catch (err) {
    const lastAttempt = job && job.attempts >= job.max_attempts;
    if (err.retryable && !lastAttempt) {
      throw new RetryableError(err.message, { delayMs: err.retryAfterMs });
    }
    await query(`UPDATE messages SET status = 'failed', failed_at = now(), error_code = $2, error_message = $3 WHERE id = $1`,
      [id, err.code != null ? String(err.code) : null, String(err.message).slice(0, 1000)]);
    await bus.publish({ tenantId: m.tenant_id, type: 'message.status', conversation_id: m.conversation_id, message_id: id, status: 'failed' });
    throw new PermanentError(err.message);
  }

  // Meta has accepted the message. From here on NEVER retry the job: a retry would
  // deliver the same message to the customer twice.
  const wamid = res?.messages?.[0]?.id || null;
  try {
    await query(
      `UPDATE messages SET status = CASE WHEN status IN ('delivered','read') THEN status ELSE 'sent' END,
              wa_message_id = $2, sent_at = COALESCE(sent_at, now()), error_code = NULL, error_message = NULL
        WHERE id = $1`, [id, wamid]);
    await bus.publish({ tenantId: m.tenant_id, type: 'message.status', conversation_id: m.conversation_id, message_id: id, status: 'sent' });
  } catch (err) {
    logger.error('message sent but status update failed', { messageId: id, wamid, error: err.message });
    throw new PermanentError(`Sent (wamid ${wamid}) but could not record it: ${err.message}`);
  }
}

module.exports = { enqueueMessage, sendToPhone, sendMessageJob, insideWindow };
