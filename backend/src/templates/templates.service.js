// WhatsApp message templates: synced from Meta (Meta approves them), plus what each
// one is used for here (purpose) and which field fills each {{n}} (variable_map).
const { query, withTx } = require('../db/pool');
const { badRequest, notFound, conflict } = require('../lib/errors');
const graph = require('../whatsapp/graph');
const { getForSending } = require('../whatsapp/account.service');
const { placeholders, VARIABLE_KEYS } = require('./render');

const PURPOSES = ['booking_confirmation', 'advance_reminder', 'event_reminder', 'review_request', 'quote_followup', 'handover_alert', 'broadcast'];
const META_STATUS = { APPROVED: 'approved', PENDING: 'pending', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'disabled', IN_APPEAL: 'pending', PENDING_DELETION: 'disabled', DELETED: 'disabled', LIMIT_EXCEEDED: 'paused' };

/** Ready-made templates for BalloonsBuzz, submitted to Meta from the Templates page. */
const RECOMMENDED = [
  {
    name: 'bb_booking_confirmed', category: 'UTILITY', purpose: 'booking_confirmation', language: 'en',
    body: 'Hi {{1}}, your BalloonsBuzz booking {{2}} is confirmed 🎉\nDate: {{3}}\nVenue: {{4}}\nAdvance received: {{5}}. Balance on the day: {{6}}.\nThank you! Reply here if anything changes.',
    map: { 1: 'contact.first_name', 2: 'booking.code', 3: 'booking.event_date', 4: 'booking.venue', 5: 'booking.advance_paid', 6: 'booking.balance' },
    examples: ['Kavya', 'BB-1001', '20 Dec 2026', 'Kondapur', '₹3,600', '₹8,400'],
  },
  {
    name: 'bb_advance_reminder', category: 'UTILITY', purpose: 'advance_reminder', language: 'en',
    body: 'Hi {{1}}, a reminder about booking {{2}} for {{3}}. The advance of {{4}} is still pending; please pay to UPI {{5}} and send us the screenshot here to confirm your date.',
    map: { 1: 'contact.first_name', 2: 'booking.code', 3: 'booking.event_date', 4: 'booking.advance_due', 5: 'payment.upi_id' },
    examples: ['Kavya', 'BB-1001', '20 Dec 2026', '₹3,600', 'balloonsbuzz@okhdfc'],
  },
  {
    name: 'bb_event_reminder', category: 'UTILITY', purpose: 'event_reminder', language: 'en',
    body: 'Hi {{1}}, our team will be at {{2}} on {{3}} at {{4}} to set up your decoration 🎈 Balance due on the day: {{5}}. Reply here if anything has changed.',
    map: { 1: 'contact.first_name', 2: 'booking.venue', 3: 'booking.event_date', 4: 'booking.event_time', 5: 'booking.balance' },
    examples: ['Kavya', 'Kondapur', '20 Dec 2026', '5:30 pm', '₹8,400'],
  },
  {
    name: 'bb_review_request', category: 'MARKETING', purpose: 'review_request', language: 'en',
    body: 'Hi {{1}}, thank you for celebrating with BalloonsBuzz 🎉 We hope you loved the decoration! Could you share a photo or a quick review? It helps us a lot 💕',
    map: { 1: 'contact.first_name' },
    examples: ['Kavya'],
  },
  {
    name: 'bb_handover_alert', category: 'UTILITY', purpose: 'handover_alert', language: 'en',
    body: 'BalloonsBuzz team: a WhatsApp chat needs a person. Customer: {{1}} ({{2}}). Reason: {{3}}. Please reply from the dashboard inbox.',
    map: { 1: 'contact.name', 2: 'contact.phone', 3: 'handover.reason' },
    examples: ['Kavya', '+91 90000 00001', 'Customer asked for a person'],
  },
];

async function accountFor(tenantId) {
  const { rows: [a] } = await query(`SELECT id FROM whatsapp_accounts WHERE tenant_id = $1 AND is_primary`, [tenantId]);
  const acc = a && await getForSending(a.id);
  // Templates live in the WhatsApp Business Account: without a connected number there is nothing to call.
  if (!acc || acc.status === 'disconnected' || !acc.token || !acc.waba_id) {
    throw conflict('Connect your WhatsApp number first (Connect number page), then try again.');
  }
  return acc;
}

async function list(tenantId) {
  const { rows } = await query(
    `SELECT t.*, (SELECT count(*)::int FROM broadcasts b WHERE b.template_id = t.id AND b.deleted_at IS NULL) AS broadcasts
       FROM templates t WHERE t.tenant_id = $1 ORDER BY (t.status = 'approved') DESC, t.name, t.language`, [tenantId]);
  return rows.map((t) => ({ ...t, placeholders: placeholders(t.components) }));
}

async function get(tenantId, id) {
  const { rows: [t] } = await query(`SELECT * FROM templates WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!t) throw notFound('Template not found');
  return { ...t, placeholders: placeholders(t.components) };
}

/** Pulls every template of the WhatsApp Business Account. Admin settings (purpose, mapping) are kept. */
async function sync(tenantId) {
  const acc = await accountFor(tenantId);
  const found = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const res = await graph.get(`${acc.waba_id}/message_templates`, {
      token: acc.token,
      query: { fields: 'id,name,language,status,category,components,rejected_reason', limit: '100', ...(after ? { after } : {}) },
    });
    found.push(...(res?.data || []));
    after = res?.paging?.cursors?.after && res?.paging?.next ? res.paging.cursors.after : null;
    if (!after) break;
  }
  let added = 0; let updated = 0;
  await withTx(async (c) => {
    for (const t of found) {
      const status = META_STATUS[t.status] || 'pending';
      const category = ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(t.category) ? t.category : 'MARKETING';
      const { rows: [r] } = await c.query(
        `INSERT INTO templates (tenant_id, whatsapp_account_id, name, language, category, status, components, meta_template_id, rejected_reason, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (whatsapp_account_id, name, language) DO UPDATE
           SET category = EXCLUDED.category, status = EXCLUDED.status, components = EXCLUDED.components,
               meta_template_id = EXCLUDED.meta_template_id, rejected_reason = EXCLUDED.rejected_reason, last_synced_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [tenantId, acc.id, t.name, t.language, category, status, JSON.stringify(t.components || []), t.id,
          t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null]);
      if (r.inserted) added += 1; else updated += 1;
    }
    // Deleted at Meta: keep the row (broadcasts reference it) but it can't be used.
    const keys = found.map((t) => `${t.name}|${t.language}`);
    await c.query(
      `UPDATE templates SET status = 'disabled', last_synced_at = now()
        WHERE whatsapp_account_id = $1 AND status <> 'disabled' AND meta_template_id IS NOT NULL AND NOT ((name || '|' || language) = ANY($2::text[]))`,
      [acc.id, keys]);
  });
  // A template that maps to a recommended one gets its purpose and mapping automatically.
  for (const r of RECOMMENDED) {
    await query(
      `UPDATE templates SET purpose = COALESCE(purpose, $3), variable_map = CASE WHEN variable_map = '{}'::jsonb THEN $4::jsonb ELSE variable_map END
        WHERE whatsapp_account_id = $1 AND name = $2`, [acc.id, r.name, r.purpose, JSON.stringify(r.map)]);
  }
  return { total: found.length, added, updated };
}

/** Admin settings: what it's for, and which field fills each {{n}}. */
async function update(tenantId, id, { purpose, variable_map: map }) {
  const t = await get(tenantId, id);
  if (purpose !== undefined && purpose !== null && !PURPOSES.includes(purpose)) throw badRequest('Unknown purpose');
  if (map) {
    for (const [n, key] of Object.entries(map)) {
      if (!/^\d+$/.test(n) || !t.placeholders.includes(Number(n))) throw badRequest(`{{${n}}} is not in this template`);
      if (!VARIABLE_KEYS.has(key)) throw badRequest(`Unknown field "${key}"`);
    }
    if (purpose && purpose !== 'broadcast' && Object.values(map).includes('static')) {
      throw badRequest('Automatic messages can’t use fixed text: map every {{n}} to a field');
    }
  }
  const { rows: [r] } = await query(
    `UPDATE templates SET purpose = CASE WHEN $3 THEN $4 ELSE purpose END, variable_map = COALESCE($5::jsonb, variable_map)
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, purpose !== undefined, purpose ?? null, map ? JSON.stringify(map) : null]);
  return { ...r, placeholders: placeholders(r.components) };
}

/** Sends one of the RECOMMENDED templates to Meta for approval. */
async function submitRecommended(tenantId, name) {
  const r = RECOMMENDED.find((x) => x.name === name);
  if (!r) throw notFound('Unknown template');
  const acc = await accountFor(tenantId);
  const res = await graph.post(`${acc.waba_id}/message_templates`, {
    name: r.name, language: r.language, category: r.category,
    components: [{ type: 'BODY', text: r.body, example: { body_text: [r.examples] } }],
  }, { token: acc.token });
  const status = META_STATUS[res?.status] || 'pending';
  const { rows: [t] } = await query(
    `INSERT INTO templates (tenant_id, whatsapp_account_id, name, language, category, status, components, meta_template_id, purpose, variable_map, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (whatsapp_account_id, name, language) DO UPDATE SET status = EXCLUDED.status, meta_template_id = EXCLUDED.meta_template_id,
       components = EXCLUDED.components, purpose = COALESCE(templates.purpose, EXCLUDED.purpose)
     RETURNING *`,
    [tenantId, acc.id, r.name, r.language, r.category, status, JSON.stringify([{ type: 'BODY', text: r.body }]), res?.id || null, r.purpose, JSON.stringify(r.map)]);
  return t;
}

/** The approved template for an automatic message, if there is one. */
async function forPurpose(tenantId, purpose, accountId = null) {
  const { rows: [t] } = await query(
    `SELECT * FROM templates WHERE tenant_id = $1 AND purpose = $2 AND status = 'approved'
        AND ($3::uuid IS NULL OR whatsapp_account_id = $3) ORDER BY updated_at DESC LIMIT 1`, [tenantId, purpose, accountId]);
  return t || null;
}

module.exports = { list, get, sync, update, submitRecommended, forPurpose, RECOMMENDED, PURPOSES };
