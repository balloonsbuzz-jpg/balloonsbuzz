// Worker handler for webhook events: inbound messages and delivery statuses.
const { query, withTx } = require('../db/pool');
const logger = require('../lib/logger');
const { normalizePhone } = require('../lib/phone');
const { RetryableError } = require('../queue/jobs');
const { normalizeInbound, previewOf } = require('./parse');
const { routeByPhoneNumberId } = require('./account.service');
const bus = require('../realtime/bus');
const { switchMode, matchesHandoverKeyword } = require('../conversations/handover.service');

const STATUS_RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

async function processWebhookEvent({ webhook_event_id: id }, job) {
  const { rows } = await query(`SELECT * FROM webhook_events WHERE id = $1`, [id]);
  const ev = rows[0];
  if (!ev || ev.status === 'processed') return;
  await query(`UPDATE webhook_events SET status = 'processing', attempts = attempts + 1 WHERE id = $1`, [id]);
  try {
    let result = 'processed';
    if (ev.event_type === 'message') await handleInboundMessage(ev);
    else if (ev.event_type === 'status') result = await handleStatus(ev, job);
    else result = 'ignored';
    await query(`UPDATE webhook_events SET status = $2, processed_at = now(), error_message = NULL WHERE id = $1`, [id, result]);
  } catch (err) {
    await query(`UPDATE webhook_events SET status = 'failed', error_message = $2 WHERE id = $1`, [id, String(err.message).slice(0, 1000)]);
    throw err;
  }
}

async function handleInboundMessage(ev) {
  const route = await routeByPhoneNumberId(ev.phone_number_id);
  if (!route) return;
  const { message: m, contact: wa } = ev.payload;
  const phone = normalizePhone(m.from) || normalizePhone(wa?.wa_id);
  if (!phone) throw new Error(`Unrecognised sender number: ${m.from}`);
  const n = normalizeInbound(m);
  const sentAt = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();

  const stored = await withTx(async (c) => {
    // contact (profile name only fills an empty name; staff edits win)
    const { rows: [contact] } = await c.query(
      `INSERT INTO contacts (tenant_id, phone, wa_id, name, source, source_metadata, last_inbound_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, phone) WHERE deleted_at IS NULL DO UPDATE
         SET wa_id = EXCLUDED.wa_id,
             name = COALESCE(contacts.name, EXCLUDED.name),
             last_inbound_at = GREATEST(contacts.last_inbound_at, EXCLUDED.last_inbound_at)
       RETURNING id`,
      [route.tenantId, phone, wa?.wa_id || m.from, wa?.profile?.name || null,
        n.payload.referral ? 'ad' : 'whatsapp', JSON.stringify(n.payload.referral ? { referral: n.payload.referral } : {}), sentAt]);

    const { rows: [conv] } = await c.query(
      `INSERT INTO conversations (tenant_id, contact_id, whatsapp_account_id) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, contact_id, whatsapp_account_id) DO UPDATE SET updated_at = now()
       RETURNING id`, [route.tenantId, contact.id, route.accountId]);

    let mediaId = null;
    if (n.media) {
      const { rows: [md] } = await c.query(
        `INSERT INTO media (tenant_id, source, mime_type, sha256, wa_media_id, original_filename)
         VALUES ($1,'inbound',$2,$3,$4,$5) RETURNING id`,
        [route.tenantId, n.media.mime_type, n.media.sha256, n.media.wa_media_id, n.media.filename]);
      mediaId = md.id;
    }

    let replyTo = null;
    if (m.context?.id) {
      const { rows: r } = await c.query(`SELECT id FROM messages WHERE tenant_id = $1 AND wa_message_id = $2`, [route.tenantId, m.context.id]);
      replyTo = r[0]?.id || null;
    }

    const { rowCount } = await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, message_type, body, payload,
                             media_id, wa_message_id, reply_to_message_id, status, sent_at, created_at)
       VALUES ($1,$2,$3,'inbound','customer',$4,$5,$6,$7,$8,$9,'received',$10,$10)
       ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
      [route.tenantId, conv.id, contact.id, n.message_type, n.body, JSON.stringify(n.payload), mediaId, m.id, replyTo, sentAt]);
    if (!rowCount) return null;   // already stored (replay)

    if (n.message_type !== 'reaction') {
      await c.query(
        `UPDATE conversations
            SET last_inbound_at = GREATEST(last_inbound_at, $2), last_message_at = GREATEST(last_message_at, $2),
                last_message_preview = $3, last_message_direction = 'inbound', unread_count = unread_count + 1,
                status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
          WHERE id = $1`, [conv.id, sentAt, previewOf(n)]);
    }
    await bus.publish({ tenantId: route.tenantId, type: 'message.new', conversation_id: conv.id, direction: 'inbound' }, c);
    return { conversationId: conv.id };
  });

  if (stored && ['text', 'button', 'interactive'].includes(n.message_type)) {
    await maybeKeywordHandover(route.tenantId, stored.conversationId, n.body);
  }
}

/** Customer asked for a person (configured keywords): pause the bot, alert the team, tell the customer. */
async function maybeKeywordHandover(tenantId, conversationId, text) {
  const { rows } = await query(`SELECT handover_keywords, handover_message FROM ai_agent_config WHERE tenant_id = $1`, [tenantId]);
  const cfg = rows[0];
  const keyword = cfg && matchesHandoverKeyword(text, cfg.handover_keywords);
  if (!keyword) return;
  await withTx(async (c) => {
    const { rows: [cv] } = await c.query(`SELECT handling_mode FROM conversations WHERE id = $1`, [conversationId]);
    if (cv?.handling_mode !== 'bot') return;   // a human already has it
    await switchMode(c, { tenantId, conversationId, to: 'human', trigger: 'keyword', reason: `Customer asked for a person ("${keyword}")`, metadata: { keyword } });
    if (cfg.handover_message) {
      const { enqueueMessage } = require('./outbound.service');
      await enqueueMessage({ tenantId, conversationId, type: 'text', content: { text: cfg.handover_message }, senderType: 'system' }, c);
    }
  });
}

async function handleStatus(ev, job) {
  const route = await routeByPhoneNumberId(ev.phone_number_id);
  if (!route) return 'ignored';
  const s = ev.payload.status;
  const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
  const { rows } = await query(`SELECT id, status, conversation_id FROM messages WHERE tenant_id = $1 AND wa_message_id = $2`, [route.tenantId, s.id]);
  const msg = rows[0];
  if (!msg) {
    // The send job may not have stored the wamid yet: retry a couple of times, then let it go
    // (statuses for messages sent outside this platform, e.g. from the phone app, are expected).
    if ((job?.attempts || 1) < 3) throw new RetryableError('message for status not found yet', { delayMs: 3000 });
    logger.info('status for unknown message ignored', { wamid: s.id, status: s.status });
    return 'ignored';
  }

  if (s.status === 'failed') {
    const e = (s.errors || [])[0] || {};
    if ((STATUS_RANK[msg.status] ?? 0) < STATUS_RANK.delivered) {
      await query(`UPDATE messages SET status = 'failed', failed_at = $2, error_code = $3, error_message = $4 WHERE id = $1`,
        [msg.id, at, e.code != null ? String(e.code) : null, [e.title, e.error_data?.details].filter(Boolean).join(': ') || 'Delivery failed']);
      await bus.publish({ tenantId: route.tenantId, type: 'message.status', conversation_id: msg.conversation_id, message_id: msg.id, status: 'failed' });
    }
    return 'processed';
  }
  const rank = STATUS_RANK[s.status];
  if (rank == null) return 'ignored';
  // Statuses can arrive out of order: only ever move forward.
  const { rowCount } = await query(
    `UPDATE messages SET status = $2,
            sent_at = CASE WHEN $2 IN ('sent','delivered','read') THEN COALESCE(sent_at, $3) ELSE sent_at END,
            delivered_at = CASE WHEN $2 IN ('delivered','read') THEN COALESCE(delivered_at, $3) ELSE delivered_at END,
            read_at = CASE WHEN $2 = 'read' THEN COALESCE(read_at, $3) ELSE read_at END
      WHERE id = $1 AND status <> 'failed'
        AND $4::int > CASE status WHEN 'queued' THEN 0 WHEN 'sending' THEN 1 WHEN 'sent' THEN 2
                                  WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 ELSE -1 END`,
    [msg.id, s.status, at, rank]);
  if (rowCount) await bus.publish({ tenantId: route.tenantId, type: 'message.status', conversation_id: msg.conversation_id, message_id: msg.id, status: s.status });
  return 'processed';
}

module.exports = { processWebhookEvent };
