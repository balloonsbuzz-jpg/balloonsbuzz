// Turns a Meta webhook body into individual events, each with a stable
// idempotency key, and normalises inbound messages into our message shape.
const crypto = require('crypto');

/**
 * @returns {Array<{eventKey, eventType, phoneNumberId, data}>}
 *   eventType: 'message' | 'status' | 'template_status' | 'unknown'
 */
function splitEvents(body, rawBody) {
  const events = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    return [{ eventKey: `body:${sha(rawBody)}`, eventType: 'unknown', phoneNumberId: null, data: body }];
  }
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const phoneNumberId = v.metadata?.phone_number_id || null;
      if (change.field === 'messages') {
        const contacts = v.contacts || [];
        for (const m of v.messages || []) {
          const contact = contacts.find((c) => c.wa_id === m.from) || contacts[0] || null;
          events.push({ eventKey: `msg:${m.id}`, eventType: 'message', phoneNumberId, data: { message: m, contact, metadata: v.metadata } });
        }
        for (const s of v.statuses || []) {
          events.push({ eventKey: `status:${s.id}:${s.status}`, eventType: 'status', phoneNumberId, data: { status: s, metadata: v.metadata } });
        }
        if (!(v.messages || []).length && !(v.statuses || []).length) {
          events.push({ eventKey: `change:${sha(JSON.stringify(change))}`, eventType: 'unknown', phoneNumberId, data: change });
        }
      } else if (change.field === 'message_template_status_update') {
        events.push({ eventKey: `tpl:${v.message_template_id}:${v.event}:${entry.time || ''}`, eventType: 'template_status', phoneNumberId, data: v });
      } else {
        events.push({ eventKey: `change:${sha(JSON.stringify(change))}`, eventType: 'unknown', phoneNumberId, data: change });
      }
    }
  }
  return events.length ? events : [{ eventKey: `body:${sha(rawBody)}`, eventType: 'unknown', phoneNumberId: null, data: body }];
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** Maps a Cloud API message object to { message_type, body, payload, media }. */
function normalizeInbound(m) {
  const out = { message_type: 'unsupported', body: null, payload: {}, media: null };
  const t = m.type;
  if (t === 'text') {
    Object.assign(out, { message_type: 'text', body: m.text?.body ?? '' });
  } else if (MEDIA_TYPES.has(t)) {
    const md = m[t] || {};
    Object.assign(out, {
      message_type: t,
      body: md.caption || null,
      media: { wa_media_id: md.id, mime_type: md.mime_type || 'application/octet-stream', sha256: md.sha256 || null, filename: md.filename || null },
      payload: t === 'audio' ? { voice: !!md.voice } : {},
    });
  } else if (t === 'location') {
    const l = m.location || {};
    Object.assign(out, {
      message_type: 'location',
      body: [l.name, l.address].filter(Boolean).join(', ') || null,
      payload: { latitude: l.latitude, longitude: l.longitude, name: l.name || null, address: l.address || null, url: l.url || null },
    });
  } else if (t === 'interactive') {
    const i = m.interactive || {};
    if (i.type === 'button_reply') {
      Object.assign(out, { message_type: 'interactive', body: i.button_reply?.title, payload: { kind: 'button_reply', id: i.button_reply?.id, title: i.button_reply?.title } });
    } else if (i.type === 'list_reply') {
      Object.assign(out, { message_type: 'interactive', body: i.list_reply?.title, payload: { kind: 'list_reply', ...i.list_reply } });
    } else if (i.type === 'location_reply' || i.location_reply) {
      // some clients send location requests back as interactive
      const l = i.location_reply || {};
      Object.assign(out, { message_type: 'location', body: l.name || l.address || null, payload: { latitude: l.latitude, longitude: l.longitude, name: l.name || null, address: l.address || null } });
    } else {
      Object.assign(out, { message_type: 'interactive', body: null, payload: { kind: i.type, raw: i } });
    }
  } else if (t === 'button') {
    Object.assign(out, { message_type: 'button', body: m.button?.text, payload: { payload: m.button?.payload } });
  } else if (t === 'reaction') {
    Object.assign(out, { message_type: 'reaction', body: m.reaction?.emoji || null, payload: { emoji: m.reaction?.emoji || null, target_wa_message_id: m.reaction?.message_id } });
  } else if (t === 'contacts') {
    Object.assign(out, { message_type: 'contacts', body: (m.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean).join(', ') || null, payload: { contacts: m.contacts } });
  } else if (t === 'order') {
    Object.assign(out, { message_type: 'order', body: m.order?.text || null, payload: { order: m.order } });
  } else {
    Object.assign(out, { message_type: 'unsupported', body: null, payload: { type: t, errors: m.errors || null } });
  }
  if (m.referral) out.payload.referral = m.referral;           // click-to-WhatsApp ad
  return out;
}

/** Short preview text for the inbox list. */
function previewOf({ message_type: type, body }) {
  if (body) return body.slice(0, 140);
  return { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Document', sticker: 'Sticker', location: '📍 Location',
    contacts: '👤 Contact', reaction: 'Reaction', template: 'Template', interactive: 'Reply', unsupported: 'Unsupported message' }[type] || type;
}

const sha = (s) => crypto.createHash('sha256').update(s || '').digest('hex');

module.exports = { splitEvents, normalizeInbound, previewOf };
