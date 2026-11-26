// The open lead of a conversation: what the agent has learned about the event.
const { query, withTx } = require('../db/pool');
const gallery = require('../gallery/gallery.service');

// What the agent qualifies before quoting a final price, in the order it asks: the date comes
// first (a same-day or past date ends the enquiry). The guest count is not asked.
const QUALIFY_FIELDS = ['event_date', 'occasion', 'theme', 'venue', 'budget'];
const OPEN_STATUSES = ['new', 'qualifying', 'quoted', 'negotiating', 'stale'];

/** Today's date in India (YYYY-MM-DD). */
function todayIST(now = Date.now()) {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

async function getOrCreate(tenantId, conversationId, db = { query }) {
  const { rows: [open] } = await db.query(
    `SELECT * FROM leads WHERE conversation_id = $1 AND deleted_at IS NULL AND status NOT IN ('won','lost')`, [conversationId]);
  if (open) return open;
  const { rows: [created] } = await db.query(
    `INSERT INTO leads (tenant_id, contact_id, conversation_id, status)
     SELECT tenant_id, contact_id, id, 'qualifying' FROM conversations WHERE id = $1 AND tenant_id = $2
     ON CONFLICT (conversation_id) WHERE deleted_at IS NULL AND status NOT IN ('won','lost') AND conversation_id IS NOT NULL
     DO UPDATE SET last_activity_at = now()
     RETURNING *`, [conversationId, tenantId]);
  return created;
}

async function get(conversationId) {
  const { rows: [l] } = await query(
    `SELECT l.*, o.name AS occasion_name, t.name AS theme_name, p.name AS package_name
       FROM leads l LEFT JOIN occasions o ON o.id = l.occasion_id LEFT JOIN themes t ON t.id = l.theme_id
       LEFT JOIN packages p ON p.id = l.package_id
      WHERE l.conversation_id = $1 AND l.deleted_at IS NULL AND l.status NOT IN ('won','lost')`, [conversationId]);
  return l || null;
}

function missingFields(l) {
  if (!l) return QUALIFY_FIELDS;
  const has = {
    occasion: !!l.occasion_id,
    theme: !!(l.theme_id || l.theme_text || l.package_id),   // a character theme or a design category
    event_date: !!l.event_date,
    venue: !!(l.venue_address || l.venue_lat != null),
    budget: l.budget_min != null || l.budget_max != null,
  };
  return QUALIFY_FIELDS.filter((f) => !has[f]);
}

/** Applies what the customer said. Unknown theme words are kept as free text. */
async function update(tenantId, conversationId, f) {
  const lead = await getOrCreate(tenantId, conversationId);
  const set = {};
  if (f.occasion) {
    const o = await gallery.resolveOccasion(tenantId, f.occasion);
    if (o) set.occasion_id = o.id;
  }
  if (f.theme) {
    const t = await gallery.resolveTheme(tenantId, f.theme);
    // "ring frame decoration" is a design category, not a theme
    const p = t ? null : await gallery.resolvePackage(tenantId, f.theme);
    if (t) { set.theme_id = t.id; set.theme_text = null; } else if (p && p.kind === 'package') set.package_id = p.id;
    else { set.theme_id = null; set.theme_text = String(f.theme).slice(0, 100); }
  }
  if (f.event_date) set.event_date = f.event_date;
  if (f.event_time) set.event_time = f.event_time;
  if (f.venue_address) set.venue_address = String(f.venue_address).slice(0, 300);
  if (f.budget_min != null || f.budget_max != null) {
    let lo = f.budget_min ?? f.budget_max; let hi = f.budget_max ?? f.budget_min;
    if (lo > hi) [lo, hi] = [hi, lo];
    set.budget_min = lo; set.budget_max = hi;
  }
  if (f.notes) set.notes = [lead.notes, String(f.notes).slice(0, 500)].filter(Boolean).join('\n').slice(-2000);
  const fields = Object.keys(set);
  if (fields.length) {
    await query(
      `UPDATE leads SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')}, last_activity_at = now() WHERE id = $1`,
      [lead.id, ...fields.map((k) => set[k])]);
  }
  const after = await get(conversationId);
  if (after && !after.qualified_at && missingFields(after).length === 0) {
    await query(`UPDATE leads SET qualified_at = now() WHERE id = $1`, [after.id]);
  }
  return after;
}

/**
 * Closes the open lead of a conversation as lost (created first if the customer says no
 * before anything was saved, so the reason still counts) and cancels its pending follow-ups.
 */
async function markLost(tenantId, conversationId, reason) {
  const lead = await getOrCreate(tenantId, conversationId);
  await withTx(async (c) => {
    await c.query(`UPDATE leads SET status = 'lost', lost_reason = $2, last_activity_at = now() WHERE id = $1`, [lead.id, String(reason).slice(0, 300)]);
    await c.query(
      `UPDATE followups SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'lead lost'
        WHERE conversation_id = $1 AND status = 'pending' AND booking_id IS NULL`, [conversationId]);
  });
  return lead.id;
}

/**
 * Open enquiries whose event day has come without a booking are lost (runs every minute).
 * Booked ones are already 'won'.
 */
async function closeDueLeads({ tenantId = null, today = todayIST() } = {}) {
  const { rows } = await query(
    `UPDATE leads SET status = 'lost', lost_reason = CASE WHEN event_date = $2::date THEN 'Event day reached without booking' ELSE 'Event date passed' END
      WHERE status = ANY($3::text[]) AND deleted_at IS NULL AND event_date <= $2::date AND ($1::uuid IS NULL OR tenant_id = $1)
      RETURNING id, conversation_id`, [tenantId, today, OPEN_STATUSES]);
  const convs = rows.map((r) => r.conversation_id).filter(Boolean);
  if (convs.length) {
    await query(
      `UPDATE followups SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'lead lost'
        WHERE conversation_id = ANY($1::uuid[]) AND status = 'pending' AND booking_id IS NULL`, [convs]);
  }
  return rows.length;
}

module.exports = { getOrCreate, get, update, missingFields, markLost, closeDueLeads, todayIST, QUALIFY_FIELDS };
