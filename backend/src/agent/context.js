// What the model sees each turn: the editable system prompt, a live context block
// (lead, quotes, photos sent, categories, hours) and the recent chat history.
const fs = require('fs');
const path = require('path');
const { query } = require('../db/pool');
const leads = require('./leads');
const { extractAmounts } = require('./guard');

const PROMPT_FILE = path.join(__dirname, '..', '..', '..', 'prompts', 'balloonsbuzz-agent.md');
let fileCache = { mtime: 0, text: null };

/** The admin-edited prompt; the recommended prompt file until someone has saved one. */
function systemPrompt(cfg) {
  if (cfg.system_prompt && !cfg.system_prompt.startsWith('PLACEHOLDER')) return cfg.system_prompt;
  try {
    const { mtimeMs } = fs.statSync(PROMPT_FILE);
    if (mtimeMs !== fileCache.mtime) fileCache = { mtime: mtimeMs, text: fs.readFileSync(PROMPT_FILE, 'utf8') };
    return fileCache.text;
  } catch {
    return cfg.system_prompt;
  }
}

const inr = (v) => `₹${Math.round(Number(v)).toLocaleString('en-IN')}`;
const range = (a, b) => (Number(a) === Number(b) ? inr(a) : `${inr(a)}–${inr(b)}`);

function istNow(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return { day: days[ist.getUTCDay()], minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(), date: ist };
}

function isOpen(workingHours, now = new Date()) {
  const { day, minutes } = istNow(now);
  const slots = workingHours?.[day] || [];
  const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return slots.some(([a, b]) => minutes >= m(a) && minutes < m(b));
}

function describeMessage(m) {
  const p = m.payload || {};
  switch (m.message_type) {
    case 'text': return m.body;
    case 'image': return m.direction === 'inbound' ? `[Customer sent a photo${m.body ? `: ${m.body}` : ''}]` : `[Photo sent: ${(m.body || '').replace(/\n/g, ' · ')}${m.gallery_item_id ? ` (photo_id ${m.gallery_item_id})` : ''}]`;
    case 'location': return `[Customer shared a location pin: latitude ${p.latitude}, longitude ${p.longitude}${p.name ? `, ${p.name}` : ''}${p.address ? `, ${p.address}` : ''}]`;
    case 'interactive': case 'button': return m.direction === 'inbound' ? `[Tapped: ${m.body}]` : (m.body || '[Buttons sent]');
    case 'audio': return '[Voice note: you cannot listen to it. Politely ask them to type.]';
    case 'video': return '[Video]';
    case 'document': return `[Document${m.body ? `: ${m.body}` : ''}]`;
    case 'sticker': case 'reaction': return m.body ? `[${m.message_type}: ${m.body}]` : `[${m.message_type}]`;
    case 'template': return `[Template message: ${m.body || ''}]`;
    default: return m.body || `[${m.message_type}]`;
  }
}

async function history(conversationId, limit) {
  const { rows } = await query(
    `SELECT id, direction, sender_type, message_type, body, payload, gallery_item_id, created_at
       FROM messages
      WHERE conversation_id = $1 AND NOT is_internal_note AND status <> 'cancelled' AND message_type <> 'reaction'
      ORDER BY created_at DESC LIMIT $2`, [conversationId, limit]);
  return rows.reverse();
}

/**
 * Chat history in OpenAI format. Team replies are labelled so the bot doesn't contradict
 * them. Photos we sent are system notes, not assistant text: otherwise the model copies
 * the "[Photo sent: …]" notation into its own replies.
 */
function toChat(rows) {
  const out = [];
  for (const m of rows) {
    const text = describeMessage(m);
    if (!text) continue;
    if (m.direction === 'inbound') out.push({ role: 'user', content: text });
    else if (m.message_type === 'image' || m.message_type === 'interactive') out.push({ role: 'system', content: `(Sent to the customer: ${text.replace(/^\[|\]$/g, '')})` });
    else if (m.sender_type === 'agent') out.push({ role: 'assistant', content: `(BalloonsBuzz team member wrote:) ${text}` });
    else out.push({ role: 'assistant', content: text });
  }
  // merge consecutive same-role messages (WhatsApp users send several short ones)
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

/** Rupee amounts the bot may say: everything a pricing tool issued in this chat. */
async function allowedAmounts(conversationId) {
  const allowed = new Set();
  const add = (v) => { if (v != null && Number(v) > 0) allowed.add(Math.round(Number(v))); };
  const [quotes, events, photos, lead, inbound] = await Promise.all([
    query(`SELECT list_price, addons_total, distance_charge, final_price, floor_price, line_items, status FROM quotes WHERE conversation_id = $1`, [conversationId]),
    query(`SELECT offered_price FROM quote_events WHERE conversation_id = $1 AND offered_price IS NOT NULL`, [conversationId]),
    query(`SELECT DISTINCT g.price_min, g.price_max FROM messages m JOIN gallery_items g ON g.id = m.gallery_item_id WHERE m.conversation_id = $1`, [conversationId]),
    query(`SELECT distance_charge FROM leads WHERE conversation_id = $1`, [conversationId]),
    query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'inbound' AND body IS NOT NULL ORDER BY created_at DESC LIMIT 40`, [conversationId]),
  ]);
  let floor = null;
  for (const q of quotes.rows) {
    add(q.list_price); add(q.addons_total); add(q.distance_charge); add(q.final_price);
    add(Number(q.list_price) + Number(q.addons_total) + Number(q.distance_charge));
    for (const l of q.line_items || []) { add(l.amount); add(l.unit_price); (l.range || []).forEach(add); }
    if (['issued', 'negotiating', 'accepted'].includes(q.status)) floor = Math.max(floor ?? 0, Number(q.floor_price));
  }
  events.rows.forEach((e) => add(e.offered_price));
  photos.rows.forEach((p) => { add(p.price_min); add(p.price_max); });
  lead.rows.forEach((l) => add(l.distance_charge));
  // The customer's own numbers (budget, offers) may be repeated, but never one below our floor:
  // "₹7,000 works!" must not slip through just because the customer said it.
  for (const m of inbound.rows) for (const v of extractAmounts(m.body)) if (floor == null || v >= floor) allowed.add(v);
  return allowed;
}

async function contextBlock({ tenantId, conversationId, now = new Date() }) {
  const [convQ, lead, quotes, photos, pkgs, biz, snippets] = await Promise.all([
    query(`SELECT cv.id, ct.name, ct.phone FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = $1`, [conversationId]),
    leads.get(conversationId),
    query(`SELECT q.id, q.final_price, q.status, q.rounds_used, p.name AS package, g.title AS photo
             FROM quotes q JOIN packages p ON p.id = q.package_id LEFT JOIN gallery_items g ON g.id = q.gallery_item_id
            WHERE q.conversation_id = $1 AND q.status IN ('issued','negotiating','accepted') ORDER BY q.created_at DESC LIMIT 5`, [conversationId]),
    // in the order the customer saw them, so "the first one" / "the 3rd" can be resolved
    query(`SELECT * FROM (
             SELECT DISTINCT ON (m.gallery_item_id) m.gallery_item_id AS id, g.title, g.price_min, g.price_max, p.name AS package, m.created_at
               FROM messages m JOIN gallery_items g ON g.id = m.gallery_item_id LEFT JOIN packages p ON p.id = g.package_id
              WHERE m.conversation_id = $1 ORDER BY m.gallery_item_id, m.created_at) s
            ORDER BY created_at LIMIT 30`, [conversationId]),
    query(`SELECT key, name, kind, price_min FROM packages WHERE tenant_id = $1 AND is_active AND deleted_at IS NULL ORDER BY sort_order`, [tenantId]),
    query(`SELECT business_name, base_address, working_hours, advance_type, advance_value FROM business_settings WHERE tenant_id = $1`, [tenantId]),
    query(`SELECT title, content FROM knowledge_snippets WHERE tenant_id = $1 AND is_active ORDER BY updated_at DESC LIMIT 20`, [tenantId]),
  ]);
  const conv = convQ.rows[0];
  const b = biz.rows[0] || {};
  const { date } = istNow(now);
  const open = isOpen(b.working_hours, now);
  const missing = leads.missingFields(lead);

  const lines = [
    '## Live context (for you only, never quote this section)',
    `Now: ${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} IST (${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()]}).`,
    `Team: ${open ? 'online now' : 'offline now (outside working hours): you still help, but say a person confirms bookings when the team is back'}.`,
    `Customer: ${conv?.name || 'name unknown'}.`,
    '',
    '### What we know about the event',
    lead ? [
      `- date: ${lead.event_date || '?'}${lead.event_time ? ` ${String(lead.event_time).slice(0, 5)}` : ''}`,
      `- occasion: ${lead.occasion_name || '?'}`,
      `- theme: ${lead.theme_name || lead.theme_text || '?'}`,
      `- venue: ${lead.venue_address || (lead.venue_lat != null ? `pin shared (${lead.distance_km} km away${lead.distance_charge != null ? `, travel ${inr(lead.distance_charge)}` : ''})` : '?')}`,
      `- budget: ${lead.budget_max != null ? range(lead.budget_min ?? lead.budget_max, lead.budget_max) : '?'}`,
    ].join('\n') : '- nothing yet',
    missing.length
      ? `Still missing: ${missing.join(', ')}. ${missing[0] === 'event_date' ? 'Ask for the event date first. ' : ''}Ask for at most one or two at a time.`
      : 'All details collected.',
    '',
    '### Quotes in this chat',
    quotes.rows.length
      ? quotes.rows.map((q) => `- quote_id ${q.id}: ${q.package}${q.photo ? ` – ${q.photo}` : ''}, current price ${inr(q.final_price)} (${q.status}, ${q.rounds_used} discount rounds)`).join('\n')
      : '- none yet (call get_pricing before saying any price)',
    '',
    '### Photos already sent, in the order the customer saw them (never send these again)',
    photos.rows.length
      ? photos.rows.map((p, i) => `${i + 1}. photo_id ${p.id}: ${p.title} · ${p.package} · ${range(p.price_min, p.price_max)}`).join('\n')
      : '- none yet',
    '',
    '### Design categories (package_key: name)',
    pkgs.rows.filter((p) => p.kind === 'package').map((p) => `${p.key}: ${p.name}${p.price_min == null ? ' (price on request)' : ''}`).join(' · '),
    `Add-ons: ${pkgs.rows.filter((p) => p.kind !== 'package').map((p) => `${p.key}: ${p.name}`).join(' · ') || 'none'}`,
  ];
  if (b.advance_value != null) lines.push(`Advance to confirm a booking: ${b.advance_type === 'percent' ? `${Number(b.advance_value)}%` : inr(b.advance_value)}.`);
  if (snippets.rows.length) {
    lines.push('', '### Business facts');
    for (const s of snippets.rows) lines.push(`- ${s.title}: ${s.content}`);
  }
  return { text: lines.join('\n'), open };
}

module.exports = { systemPrompt, history, toChat, allowedAmounts, contextBlock, isOpen, describeMessage, PROMPT_FILE };
