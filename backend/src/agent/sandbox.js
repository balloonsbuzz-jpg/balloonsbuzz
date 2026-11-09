// AI test console: a private chat per dashboard user that runs the REAL agent, tools,
// guard and handover rules, but never reaches WhatsApp (messages are stored as sent).
const crypto = require('crypto');
const { query, withTx } = require('../db/pool');
const { badRequest } = require('../lib/errors');
const bus = require('../realtime/bus');
const { switchModeTx } = require('../conversations/handover.service');
const { maybeKeywordHandover } = require('../whatsapp/inbound.service');
const { cancelFollowupsOnReply } = require('./jobs');
const { runTurn } = require('./runtime');
const leads = require('./leads');

/** A fake but valid phone per user: 1999 + 8 digits from the user id. */
function sandboxPhone(userId) {
  const n = parseInt(crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12), 16) % 1e8;
  return `1999${String(n).padStart(8, '0')}`;
}

async function ensure(user) {
  const phone = sandboxPhone(user.id);
  return withTx(async (c) => {
    const { rows: [contact] } = await c.query(
      `INSERT INTO contacts (tenant_id, phone, name, source) VALUES ($1,$2,$3,'sandbox')
       ON CONFLICT (tenant_id, phone) WHERE deleted_at IS NULL DO UPDATE SET updated_at = now() RETURNING id`,
      [user.tenantId, phone, `Test customer (${user.fullName || 'you'})`]);
    const { rows: [existing] } = await c.query(`SELECT id FROM conversations WHERE contact_id = $1 AND is_sandbox`, [contact.id]);
    if (existing) return existing.id;
    const { rows: [conv] } = await c.query(
      `INSERT INTO conversations (tenant_id, contact_id, whatsapp_account_id, is_sandbox) VALUES ($1,$2,NULL,true) RETURNING id`,
      [user.tenantId, contact.id]);
    return conv.id;
  });
}

async function state(user) {
  const conversationId = await ensure(user);
  const [conv, messages, lead, quotes, runs] = await Promise.all([
    query(`SELECT id, handling_mode, needs_human, handover_reason FROM conversations WHERE id = $1`, [conversationId]),
    query(`SELECT m.id, m.direction, m.sender_type, m.message_type, m.body, m.payload, m.status, m.is_internal_note, m.created_at,
                  m.gallery_item_id, COALESCE(a.thumb_url, a.public_url) AS image_url
             FROM messages m LEFT JOIN gallery_items g ON g.id = m.gallery_item_id LEFT JOIN gallery_assets a ON a.id = g.asset_id
            WHERE m.conversation_id = $1 ORDER BY m.created_at, m.id LIMIT 300`, [conversationId]),
    leads.get(conversationId),
    query(`SELECT q.id, q.status, q.list_price, q.addons_total, q.distance_charge, q.final_price, q.floor_price, q.rounds_used, p.name AS package, g.title AS photo
             FROM quotes q JOIN packages p ON p.id = q.package_id LEFT JOIN gallery_items g ON g.id = q.gallery_item_id
            WHERE q.conversation_id = $1 ORDER BY q.created_at DESC LIMIT 10`, [conversationId]),
    query(`SELECT r.id, r.outcome, r.blocked_reason, r.error_message, r.model, r.input_tokens, r.cached_input_tokens, r.output_tokens,
                  r.cost_inr, r.latency_ms, r.iterations, r.started_at,
                  COALESCE(json_agg(json_build_object('tool', t.tool_name, 'arguments', t.arguments, 'result', t.result, 'success', t.success,
                    'error', t.error_message, 'ms', t.duration_ms) ORDER BY t.created_at) FILTER (WHERE t.id IS NOT NULL), '[]') AS tool_calls
             FROM ai_runs r LEFT JOIN ai_tool_calls t ON t.ai_run_id = r.id
            WHERE r.conversation_id = $1 GROUP BY r.id ORDER BY r.started_at DESC LIMIT 20`, [conversationId]),
  ]);
  return {
    conversation: conv.rows[0],
    messages: messages.rows.map((m) => ({ ...m, payload: m.payload?.send ? { send_type: m.payload.send.type, text: m.payload.send.content?.text } : m.payload })),
    lead: lead ? { ...lead, missing: leads.missingFields(lead) } : { missing: leads.QUALIFY_FIELDS },
    quotes: quotes.rows,
    runs: runs.rows,
  };
}

/** The tester types as the customer (or shares a pin); the agent answers synchronously. */
async function customerSays(user, { text, location }) {
  if (!text && !location) throw badRequest('Type a message or share a location');
  const conversationId = await ensure(user);
  const type = location ? 'location' : 'text';
  const body = location ? (location.address || location.name || null) : text;
  const payload = location ? { latitude: location.lat, longitude: location.lng, name: location.name || null, address: location.address || null } : {};
  const messageId = await withTx(async (c) => {
    const { rows: [cv] } = await c.query(`SELECT contact_id FROM conversations WHERE id = $1`, [conversationId]);
    const { rows: [m] } = await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, message_type, body, payload, status, wa_message_id, sent_at)
       VALUES ($1,$2,$3,'inbound','customer',$4,$5,$6,'received','sandbox.in.' || gen_random_uuid(), now()) RETURNING id`,
      [user.tenantId, conversationId, cv.contact_id, type, body, JSON.stringify(payload)]);
    await c.query(
      `UPDATE conversations SET last_inbound_at = now(), last_message_at = now(), last_message_preview = $2, last_message_direction = 'inbound' WHERE id = $1`,
      [conversationId, (body || '📍 Location').slice(0, 120)]);
    await cancelFollowupsOnReply(conversationId, c);
    return m.id;
  });
  const handed = type === 'text' ? await maybeKeywordHandover(user.tenantId, conversationId, text) : false;
  let result;
  if (handed) result = { outcome: 'handover', messages: 0, keyword: true };
  else {
    try {
      result = await runTurn({ tenantId: user.tenantId, conversationId, triggerMessageId: messageId, sandbox: true });
    } catch (err) {
      // Show the problem (wrong API key, model down…) in the console; live chats hand over instead.
      result = { outcome: 'error', run_id: err.runId || null, error: String(err.message).slice(0, 300) };
    }
  }
  await bus.publish({ tenantId: user.tenantId, type: 'sandbox.updated', conversation_id: conversationId });
  return result;
}

async function reset(user) {
  await query(`DELETE FROM contacts WHERE tenant_id = $1 AND phone = $2 AND source = 'sandbox'`, [user.tenantId, sandboxPhone(user.id)]);
}

async function resume(user) {
  const conversationId = await ensure(user);
  await switchModeTx({ tenantId: user.tenantId, conversationId, to: 'bot', trigger: 'agent_resume', actorUserId: user.id, reason: 'Test console' });
}

module.exports = { ensure, state, customerSays, reset, resume, sandboxPhone };
