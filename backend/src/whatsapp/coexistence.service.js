// Coexistence webhooks: the number is also used in the WhatsApp Business app on a phone.
//   smb_message_echoes  a message the team sent from the phone  -> stored as ours, bot steps aside
//   smb_app_state_sync  the phone's address book                -> contact names
//   history             chats from the last 180 days            -> inbox history (no replies, no unread)
const { query, withTx } = require('../db/pool');
const { normalizePhone } = require('../lib/phone');
const logger = require('../lib/logger');
const bus = require('../realtime/bus');
const { switchMode } = require('../conversations/handover.service');
const { normalizeInbound, previewOf } = require('./parse');

const at = (ts) => {
  const n = Number(ts);
  return n > 0 ? new Date(n < 1e11 ? n * 1000 : n) : new Date();
};

async function upsertConversation(c, route, phone) {
  const { rows: [contact] } = await c.query(
    `INSERT INTO contacts (tenant_id, phone, wa_id, source) VALUES ($1,$2,$2,'whatsapp')
     ON CONFLICT (tenant_id, phone) WHERE deleted_at IS NULL DO UPDATE SET wa_id = COALESCE(contacts.wa_id, EXCLUDED.wa_id)
     RETURNING id`, [route.tenantId, phone]);
  const { rows: [conv] } = await c.query(
    `INSERT INTO conversations (tenant_id, contact_id, whatsapp_account_id) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, contact_id, whatsapp_account_id) DO UPDATE SET updated_at = now()
     RETURNING id`, [route.tenantId, contact.id, route.accountId]);
  return { contactId: contact.id, conversationId: conv.id };
}

async function insertMedia(c, tenantId, media) {
  if (!media?.wa_media_id) return null;
  const { rows: [md] } = await c.query(
    `INSERT INTO media (tenant_id, source, mime_type, sha256, wa_media_id, original_filename) VALUES ($1,'inbound',$2,$3,$4,$5) RETURNING id`,
    [tenantId, media.mime_type, media.sha256, media.wa_media_id, media.filename]);
  return md.id;
}

/** The team replied from the phone: show it in the inbox and keep the bot quiet in this chat. */
async function handleEcho(ev, route) {
  const m = ev.payload.echo;
  if (['revoke', 'edit'].includes(m.type)) return 'ignored';
  const phone = normalizePhone(m.to);
  if (!phone) return 'ignored';   // group or username-only chat
  const n = normalizeInbound(m);
  const sentAt = at(m.timestamp);
  await withTx(async (c) => {
    const { contactId, conversationId } = await upsertConversation(c, route, phone);
    const { rowCount: known } = await c.query(`SELECT 1 FROM messages WHERE tenant_id = $1 AND wa_message_id = $2`, [route.tenantId, m.id]);
    if (known) return;
    const mediaId = await insertMedia(c, route.tenantId, n.media);
    const { rows: [msg] } = await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, message_type, body, payload, media_id,
                             wa_message_id, status, sent_at, created_at)
       VALUES ($1,$2,$3,'outbound','agent',$4,$5,$6,$7,$8,'sent',$9,$9)
       ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING RETURNING id`,
      [route.tenantId, conversationId, contactId, n.message_type, n.body, JSON.stringify({ ...n.payload, via: 'whatsapp_app' }), mediaId, m.id, sentAt]);
    if (!msg) return;
    if (n.message_type !== 'reaction') {
      await c.query(
        `UPDATE conversations SET last_message_at = GREATEST(last_message_at, $2), unread_count = 0,
                last_message_preview = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_preview END,
                last_message_direction = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN 'outbound' ELSE last_message_direction END
          WHERE id = $1`, [conversationId, sentAt, previewOf(n)]);
      await switchMode(c, { tenantId: route.tenantId, conversationId, to: 'human', trigger: 'agent_reply',
        reason: 'Replied from the WhatsApp Business app', metadata: { via: 'whatsapp_app' } });
    }
    await bus.publish({ tenantId: route.tenantId, type: 'message.new', conversation_id: conversationId, message_id: msg.id }, c);
  });
  return 'processed';
}

/** Address book: names only fill blanks; people who never wrote to us are kept out of broadcasts. */
async function handleContactsSync(ev, route) {
  const people = [];
  for (const s of ev.payload.state_sync || []) {
    const phone = s.type === 'contact' && s.action !== 'remove' ? normalizePhone(s.contact?.phone_number) : null;
    const name = (s.contact?.full_name || s.contact?.first_name || '').trim().slice(0, 200);
    if (phone && name) people.push({ phone, name });
  }
  if (people.length) {
    const unique = [...new Map(people.map((p) => [p.phone, p])).values()];
    await query(
      `INSERT INTO contacts (tenant_id, phone, name, source, source_metadata, opted_in, opted_out_at)
       SELECT $1, p.phone, p.name, 'import', '{"address_book": true}'::jsonb, false, now()
         FROM jsonb_to_recordset($2::jsonb) AS p(phone text, name text)
       ON CONFLICT (tenant_id, phone) WHERE deleted_at IS NULL DO UPDATE SET name = COALESCE(contacts.name, EXCLUDED.name)`,
      [route.tenantId, JSON.stringify(unique)]);
  }
  await query(`UPDATE whatsapp_accounts SET contacts_sync_status = 'completed' WHERE id = $1 AND is_coexistence`, [route.accountId]);
  return 'processed';
}

const HISTORY_DECLINED = 2593109;
const OUT_STATUS = { sent: 'sent', delivered: 'delivered', read: 'read', played: 'read', error: 'failed', pending: 'sent' };

async function handleHistory(ev, route) {
  const v = ev.payload;
  const chunks = v.history || [];
  const errors = chunks.flatMap((h) => h.errors || []);
  if (errors.length) {
    const declined = errors.some((e) => e.code === HISTORY_DECLINED);
    await query(`UPDATE whatsapp_accounts SET history_sync_status = $2 WHERE id = $1`, [route.accountId, declined ? 'declined' : 'failed']);
    if (!declined) logger.warn('history sync error', { errors });
    return 'processed';
  }
  const { rows: [acc] } = await query(`SELECT display_phone FROM whatsapp_accounts WHERE id = $1`, [route.accountId]);
  const ours = normalizePhone(v.metadata?.display_phone_number) || acc.display_phone;
  let progress = null;
  for (const h of chunks) {
    for (const t of h.threads || []) {
      const phone = normalizePhone(t.context?.wa_id) || normalizePhone(t.id);
      if (phone) await storeThread(route, phone, ours, t.messages || []);
    }
    if (h.metadata?.progress != null) progress = Math.max(progress ?? 0, Number(h.metadata.progress) || 0);
  }
  // Media of recent messages follows separately, as plain messages.
  for (const m of v.messages || []) {
    const phone = normalizePhone(m.from) === ours ? normalizePhone(m.to) : normalizePhone(m.from);
    if (phone) await storeThread(route, phone, ours, [m]);
  }
  if (progress != null) {
    // Chunks arrive out of order: progress only moves forward.
    await query(
      `UPDATE whatsapp_accounts
          SET history_sync_progress = GREATEST(COALESCE(history_sync_progress, 0), LEAST($2::int, 100)),
              history_sync_status = CASE WHEN history_sync_status = 'completed' OR $2::int >= 100 THEN 'completed' ELSE 'syncing' END
        WHERE id = $1`, [route.accountId, progress]);
  }
  return 'processed';
}

async function storeThread(route, phone, ours, messages) {
  const list = messages.filter((m) => m?.id && m.type !== 'revoke' && m.type !== 'edit');
  if (!list.length) return;
  await withTx(async (c) => {
    const { contactId, conversationId } = await upsertConversation(c, route, phone);
    const rows = [];
    for (const m of list) {
      const n = normalizeInbound(m);
      const outbound = normalizePhone(m.from) === ours;
      rows.push({
        wa_message_id: m.id, direction: outbound ? 'outbound' : 'inbound', sender_type: outbound ? 'agent' : 'customer',
        message_type: n.message_type, body: n.body,
        payload: { ...n.payload, via: 'history', ...(m.type === 'media_placeholder' ? { media_placeholder: true } : {}) },
        media_id: await insertMedia(c, route.tenantId, n.media),
        status: outbound ? OUT_STATUS[String(m.history_context?.status || '').toLowerCase()] || 'sent' : 'received',
        at: at(m.timestamp).toISOString(),
      });
    }
    const unique = [...new Map(rows.map((r) => [r.wa_message_id, r])).values()];
    // A message already known wins, except a photo placeholder, which the real photo replaces.
    await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, message_type, body, payload, media_id,
                             wa_message_id, status, sent_at, created_at)
       SELECT $1, $2, $3, r.direction, r.sender_type, r.message_type, r.body, r.payload, r.media_id, r.wa_message_id, r.status, r.at, r.at
         FROM jsonb_to_recordset($4::jsonb) AS r(direction text, sender_type text, message_type text, body text, payload jsonb, media_id uuid,
                                                 wa_message_id text, status text, at timestamptz)
       ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO UPDATE
         SET message_type = EXCLUDED.message_type, body = EXCLUDED.body, payload = EXCLUDED.payload, media_id = EXCLUDED.media_id
       WHERE messages.payload->>'media_placeholder' = 'true' AND EXCLUDED.media_id IS NOT NULL`,
      [route.tenantId, conversationId, contactId, JSON.stringify(unique)]);

    const real = unique.filter((r) => r.message_type !== 'reaction').sort((a, b) => a.at.localeCompare(b.at));
    const last = real[real.length - 1];
    const lastIn = real.filter((r) => r.direction === 'inbound').pop();
    if (last) {
      await c.query(
        `UPDATE conversations
            SET last_inbound_at = GREATEST(last_inbound_at, $2::timestamptz),
                last_message_preview = CASE WHEN last_message_at IS NULL OR $3::timestamptz > last_message_at THEN $4 ELSE last_message_preview END,
                last_message_direction = CASE WHEN last_message_at IS NULL OR $3::timestamptz > last_message_at THEN $5 ELSE last_message_direction END,
                last_message_at = GREATEST(last_message_at, $3::timestamptz)
          WHERE id = $1`, [conversationId, lastIn?.at || null, last.at, previewOf(last), last.direction]);
    }
    if (lastIn) {
      await c.query(
        `UPDATE contacts SET last_inbound_at = GREATEST(last_inbound_at, $2::timestamptz) WHERE id = $1`, [contactId, lastIn.at]);
      await clearAddressBookMark(c, contactId);
    }
    await bus.publish({ tenantId: route.tenantId, type: 'conversation.updated', conversation_id: conversationId }, c);
  });
}

/** Someone from the address book who does write to us is a normal customer (may get offers). */
async function clearAddressBookMark(c, contactId) {
  await c.query(
    `UPDATE contacts SET opted_in = true, opted_out_at = NULL, source_metadata = source_metadata - 'address_book'
      WHERE id = $1 AND source_metadata ? 'address_book'`, [contactId]);
}

module.exports = { handleEcho, handleContactsSync, handleHistory, clearAddressBookMark };
