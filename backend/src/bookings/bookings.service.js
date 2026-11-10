// Bookings: created from an agreed quote (by the bot or the team), advance payments,
// status changes, and the confirmation message when the advance arrives.
//
// The negotiation floor holds here too: agreed_price >= floor_price is checked in code
// and again by a CHECK constraint in the database.
const { query, withTx } = require('../db/pool');
const { badRequest, notFound, conflict } = require('../lib/errors');
const audit = require('../services/audit.service');
const bus = require('../realtime/bus');
const { enqueueMessage } = require('../whatsapp/outbound.service');

const STATUSES = ['advance_pending', 'confirmed', 'completed', 'cancelled'];
const inr = (v) => `₹${Math.round(Number(v)).toLocaleString('en-IN')}`;

async function settings(tenantId, db = { query }) {
  const { rows: [s] } = await db.query(
    `SELECT advance_type, advance_value, min_lead_time_hours, max_bookings_per_day, upi_vpa, upi_payee_name, business_name, extra
       FROM business_settings WHERE tenant_id = $1`, [tenantId]);
  return s || {};
}

/** Advance to ask for: % of the agreed price (rounded up to ₹100) or a fixed amount. */
function advanceFor(agreed, s) {
  if (s.advance_value == null) return 0;
  const v = Number(s.advance_value);
  if (s.advance_type === 'fixed') return Math.min(v, agreed);
  return Math.min(agreed, Math.ceil((agreed * v) / 100 / 100) * 100);
}

/** Bookings already on a date vs the daily capacity. */
async function dateLoad(tenantId, date, { excludeId = null } = {}, db = { query }) {
  const s = await settings(tenantId, db);
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM bookings
      WHERE tenant_id = $1 AND event_date = $2 AND status NOT IN ('cancelled') AND deleted_at IS NULL
        AND ($3::uuid IS NULL OR id <> $3)`, [tenantId, date, excludeId]);
  const max = s.max_bookings_per_day ?? null;
  return { date, count: r.n, max, full: max != null && r.n >= max };
}

/** Is the event far enough ahead? (IST, compared in the database) */
async function leadTimeOk(tenantId, date, time) {
  const s = await settings(tenantId);
  const { rows: [r] } = await query(
    `SELECT (($1::date + COALESCE($2::time, '10:00')) AT TIME ZONE 'Asia/Kolkata') >= now() + make_interval(hours => $3) AS ok`,
    [date, time || null, s.min_lead_time_hours ?? 24]);
  return { ok: r.ok, hours: s.min_lead_time_hours ?? 24 };
}

/**
 * Create a booking from a quote.
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.quoteId
 * @param {string} p.eventDate YYYY-MM-DD
 * @param {string} [p.eventTime] HH:MM
 * @param {string} p.venueAddress
 * @param {number} [p.guestCount]
 * @param {string} [p.specialRequests]
 * @param {{type:'bot'|'agent', userId?:string}} p.createdBy
 * @param {boolean} [p.allowOverCapacity] team members may book past the daily limit (after a warning)
 */
async function createFromQuote(p) {
  const { rows: [q] } = await query(
    `SELECT q.*, l.contact_id, l.occasion_id, l.venue_lat, l.venue_lng, l.distance_km, l.guest_count AS lead_guests, l.conversation_id AS lead_conversation_id
       FROM quotes q JOIN leads l ON l.id = q.lead_id WHERE q.id = $1 AND q.tenant_id = $2`, [p.quoteId, p.tenantId]);
  if (!q) throw notFound('Quote not found');
  if (['superseded', 'expired', 'escalated'].includes(q.status)) throw conflict(`That quote is ${q.status}; give a new price first.`);
  const { rows: [existing] } = await query(`SELECT booking_code FROM bookings WHERE quote_id = $1 AND status <> 'cancelled'`, [q.id]);
  if (existing) throw conflict(`This quote is already booked (${existing.booking_code}).`, { code: 'already_booked', booking_code: existing.booking_code });

  const quoted = Number(q.list_price) + Number(q.addons_total) + Number(q.distance_charge);
  const agreed = Number(q.final_price);
  const floor = Number(q.floor_price);
  if (agreed < floor) throw badRequest('The agreed price is below the lowest allowed price.');   // the DB CHECK would refuse too

  const load = await dateLoad(p.tenantId, p.eventDate);
  if (load.full && !p.allowOverCapacity) {
    throw conflict(`${p.eventDate} already has ${load.count} booking${load.count === 1 ? '' : 's'} (daily limit ${load.max}).`, { code: 'capacity', ...load });
  }
  const s = await settings(p.tenantId);
  const advance = advanceFor(agreed, s);

  const booking = await withTx(async (c) => {
    const { rows: [b] } = await c.query(
      `INSERT INTO bookings (tenant_id, lead_id, contact_id, quote_id, package_id, theme_id, occasion_id, gallery_item_id,
                             event_date, event_time, venue_address, venue_lat, venue_lng, distance_km, guest_count,
                             quoted_price, agreed_price, floor_price, distance_charge, advance_amount, special_requests,
                             created_by_type, created_by_user_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'advance_pending')
       RETURNING *`,
      [p.tenantId, q.lead_id, q.contact_id, q.id, q.package_id, q.theme_id, q.occasion_id, q.gallery_item_id,
        p.eventDate, p.eventTime || null, p.venueAddress, q.venue_lat, q.venue_lng, q.distance_km, p.guestCount || q.lead_guests || null,
        quoted, agreed, floor, q.distance_charge, advance, p.specialRequests || null, p.createdBy.type, p.createdBy.userId || null]);
    await c.query(`UPDATE quotes SET status = 'accepted' WHERE id = $1`, [q.id]);
    await c.query(`INSERT INTO quote_events (tenant_id, quote_id, conversation_id, event_type, offered_price, actor_type, metadata)
                   VALUES ($1,$2,$3,'accepted',$4,$5,$6)`,
    [p.tenantId, q.id, q.conversation_id, agreed, p.createdBy.type, JSON.stringify({ booking_id: b.id })]);
    await c.query(
      `UPDATE leads SET status = 'won', event_date = $2, event_time = COALESCE($3, event_time), venue_address = $4, last_activity_at = now() WHERE id = $1`,
      [q.lead_id, p.eventDate, p.eventTime || null, p.venueAddress]);
    await audit.record({
      tenantId: p.tenantId, actorType: p.createdBy.type === 'bot' ? 'bot' : 'user', actorUserId: p.createdBy.userId || null,
      action: 'booking.create', entityType: 'booking', entityId: b.id, after: { code: b.booking_code, agreed_price: agreed, event_date: p.eventDate },
    }, c);
    await bus.publish({ tenantId: p.tenantId, type: 'booking.updated', booking_id: b.id }, c);
    return b;
  }, { type: p.createdBy.type, userId: p.createdBy.userId });

  return { booking, capacity: { ...load, count: load.count + 1, full: load.max != null && load.count + 1 >= load.max }, upi: s.upi_vpa ? { vpa: s.upi_vpa, name: s.upi_payee_name } : null };
}

/** The booking card shown on the board and in the details sheet. */
const BOOKING_SELECT = `
  SELECT b.*, ct.name AS contact_name, ct.phone AS contact_phone, p.name AS package_name, t.name AS theme_name, o.name AS occasion_name,
         g.title AS photo_title, COALESCE(a.thumb_url, a.public_url) AS photo_url, l.conversation_id, u.full_name AS assigned_user_name,
         (SELECT count(*)::int FROM bookings x WHERE x.tenant_id = b.tenant_id AND x.event_date = b.event_date
             AND x.status <> 'cancelled' AND x.deleted_at IS NULL) AS bookings_that_day
    FROM bookings b
    JOIN contacts ct ON ct.id = b.contact_id
    JOIN packages p ON p.id = b.package_id
    LEFT JOIN themes t ON t.id = b.theme_id
    LEFT JOIN occasions o ON o.id = b.occasion_id
    LEFT JOIN gallery_items g ON g.id = b.gallery_item_id
    LEFT JOIN gallery_assets a ON a.id = g.asset_id
    LEFT JOIN leads l ON l.id = b.lead_id
    LEFT JOIN users u ON u.id = b.assigned_user_id`;

async function get(tenantId, id) {
  const { rows: [b] } = await query(`${BOOKING_SELECT} WHERE b.id = $1 AND b.tenant_id = $2 AND b.deleted_at IS NULL`, [id, tenantId]);
  if (!b) throw notFound('Booking not found');
  const [payments, history, quote] = await Promise.all([
    query(`SELECT bp.*, u.full_name AS recorded_by_name FROM booking_payments bp LEFT JOIN users u ON u.id = bp.recorded_by
            WHERE bp.booking_id = $1 ORDER BY bp.received_at`, [id]),
    query(`SELECT h.*, u.full_name AS actor_name FROM booking_status_history h LEFT JOIN users u ON u.id = h.actor_user_id
            WHERE h.booking_id = $1 ORDER BY h.created_at`, [id]),
    b.quote_id ? query(`SELECT line_items, rounds_used FROM quotes WHERE id = $1`, [b.quote_id]) : { rows: [] },
  ]);
  const s = await settings(tenantId);
  return { ...b, payments: payments.rows, history: history.rows, line_items: quote.rows[0]?.line_items || [], capacity_max: s.max_bookings_per_day ?? null };
}

/** Kanban: leads that haven't booked yet (Enquiry, Quoted) + bookings by status. */
async function board(tenantId) {
  const s = await settings(tenantId);
  const [leads, bookings] = await Promise.all([
    query(`SELECT l.id, l.status, l.event_date, l.budget_min, l.budget_max, l.last_activity_at, l.conversation_id, l.guest_count,
                  ct.name AS contact_name, ct.phone AS contact_phone, o.name AS occasion_name, COALESCE(t.name, l.theme_text) AS theme_name,
                  p.name AS package_name, cv.handling_mode,
                  (SELECT q.final_price FROM quotes q WHERE q.lead_id = l.id AND q.status IN ('issued','negotiating','accepted') ORDER BY q.created_at DESC LIMIT 1) AS latest_price,
                  (SELECT q.id FROM quotes q WHERE q.lead_id = l.id AND q.status IN ('issued','negotiating','accepted') ORDER BY q.created_at DESC LIMIT 1) AS latest_quote_id
             FROM leads l JOIN contacts ct ON ct.id = l.contact_id
             LEFT JOIN conversations cv ON cv.id = l.conversation_id
             LEFT JOIN occasions o ON o.id = l.occasion_id LEFT JOIN themes t ON t.id = l.theme_id LEFT JOIN packages p ON p.id = l.package_id
            WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND l.status IN ('new','qualifying','quoted','negotiating')
              AND ct.source <> 'sandbox' AND l.last_activity_at > now() - interval '60 days'
            ORDER BY l.last_activity_at DESC LIMIT 200`, [tenantId]),
    query(`${BOOKING_SELECT}
            WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND ct.source <> 'sandbox'
              AND (b.status IN ('advance_pending','confirmed') OR b.updated_at > now() - interval '30 days')
            ORDER BY b.event_date, b.event_time NULLS LAST`, [tenantId]),
  ]);
  const col = (st) => bookings.rows.filter((b) => b.status === st);
  return {
    capacity_max: s.max_bookings_per_day ?? null,
    columns: {
      enquiry: leads.rows.filter((l) => ['new', 'qualifying'].includes(l.status)),
      quoted: leads.rows.filter((l) => ['quoted', 'negotiating'].includes(l.status)),
      advance_pending: col('advance_pending'),
      confirmed: col('confirmed'),
      completed: col('completed'),
      cancelled: col('cancelled'),
    },
  };
}

/** Message the customer when the booking is confirmed: approved template, else text inside the 24h window. */
async function sendConfirmation(tenantId, bookingId) {
  const { rows: [b] } = await query(
    `SELECT b.*, ct.name AS contact_name, p.name AS package_name, l.conversation_id,
            (cv.last_inbound_at > now() - interval '24 hours') AS window_open, cv.whatsapp_account_id
       FROM bookings b JOIN contacts ct ON ct.id = b.contact_id JOIN packages p ON p.id = b.package_id
       LEFT JOIN leads l ON l.id = b.lead_id LEFT JOIN conversations cv ON cv.id = l.conversation_id
      WHERE b.id = $1`, [bookingId]);
  if (!b?.conversation_id) return { sent: false, reason: 'no conversation' };
  const vars = {
    'contact.name': b.contact_name || 'there', 'booking.code': b.booking_code, 'booking.event_date': b.event_date,
    'booking.venue': b.venue_address, 'booking.design': b.package_name, 'booking.agreed_price': inr(b.agreed_price),
    'booking.advance_paid': inr(b.advance_paid_amount), 'booking.balance': inr(Number(b.agreed_price) - Number(b.advance_paid_amount)),
  };
  const { rows: [tpl] } = b.whatsapp_account_id ? await query(
    `SELECT name, language, variable_map FROM templates WHERE tenant_id = $1 AND whatsapp_account_id = $2 AND purpose = 'booking_confirmation' AND status = 'approved'
      ORDER BY updated_at DESC LIMIT 1`, [tenantId, b.whatsapp_account_id]) : { rows: [] };
  if (tpl) {
    const keys = Object.keys(tpl.variable_map || {}).sort((x, y) => Number(x) - Number(y));
    const params = keys.map((k) => ({ type: 'text', text: String(vars[tpl.variable_map[k]] ?? '') }));
    const msg = await enqueueMessage({ tenantId, conversationId: b.conversation_id, type: 'template', senderType: 'system',
      content: { name: tpl.name, language: tpl.language, components: params.length ? [{ type: 'body', parameters: params }] : [] } });
    return { sent: true, via: 'template', template: tpl.name, message_id: msg.id };
  }
  if (b.window_open) {
    const text = `🎉 Booking confirmed! ${b.booking_code}\n${b.package_name} on ${b.event_date}${b.event_time ? ` at ${String(b.event_time).slice(0, 5)}` : ''}\n`
      + `Advance received: ${vars['booking.advance_paid']} · Balance: ${vars['booking.balance']}\nThank you for choosing BalloonsBuzz 🎈`;
    const msg = await enqueueMessage({ tenantId, conversationId: b.conversation_id, type: 'text', content: { text }, senderType: 'system' });
    return { sent: true, via: 'text', message_id: msg.id };
  }
  return { sent: false, reason: 'No approved "booking_confirmation" template and the 24-hour window is closed' };
}

const ALLOWED = {
  advance_pending: ['confirmed', 'cancelled'],
  confirmed: ['advance_pending', 'completed', 'cancelled'],
  completed: ['confirmed'],
  cancelled: ['advance_pending'],
};

async function setStatus(req, id, { status, reason }) {
  const before = await get(req.user.tenantId, id);
  if (before.status === status) return { booking: before };
  if (!ALLOWED[before.status]?.includes(status)) throw badRequest(`A booking can't move from ${before.status.replace('_', ' ')} to ${status.replace('_', ' ')}.`);
  if (status === 'cancelled' && !reason) throw badRequest('Give a reason for cancelling');
  if (before.status === 'cancelled') {
    const load = await dateLoad(req.user.tenantId, before.event_date, { excludeId: id });
    if (load.full) throw conflict(`${before.event_date} is already full (${load.count}/${load.max}).`, { code: 'capacity', ...load });
  }
  await withTx(async (c) => {
    await c.query(
      `UPDATE bookings SET status = $2,
              cancelled_reason = CASE WHEN $2 = 'cancelled' THEN $3 ELSE NULL END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE NULL END,
              confirmed_at = CASE WHEN $2 = 'confirmed' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
              completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END
        WHERE id = $1`, [id, status, reason || null]);
    await audit.fromReq(req, { action: 'booking.status', entityType: 'booking', entityId: id, before: { status: before.status }, after: { status, reason: reason || null } }, c);
    await bus.publish({ tenantId: req.user.tenantId, type: 'booking.updated', booking_id: id }, c);
  }, { type: 'agent', userId: req.user.id });
  let confirmation = null;
  if (status === 'confirmed' && !before.confirmed_at) confirmation = await sendConfirmation(req.user.tenantId, id);
  return { booking: await get(req.user.tenantId, id), confirmation };
}

/** Record money received. When the advance is fully paid, the booking is confirmed and the customer told. */
async function recordPayment(req, id, p) {
  const before = await get(req.user.tenantId, id);
  if (before.status === 'cancelled' && p.kind !== 'refund') throw badRequest('This booking is cancelled');
  const paidAfter = Number(before.advance_paid_amount) + (p.kind === 'refund' ? -p.amount : p.amount);
  if (paidAfter > Number(before.agreed_price)) throw badRequest(`That's more than the agreed price (${inr(before.agreed_price)}).`);
  if (paidAfter < 0) throw badRequest('Refund is more than what was paid');
  try {
    await withTx(async (c) => {
      const { rows: [pay] } = await c.query(
        `INSERT INTO booking_payments (tenant_id, booking_id, kind, amount, method, reference, received_at, recorded_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,$9) RETURNING id`,
        [req.user.tenantId, id, p.kind || 'payment', p.amount, p.method, p.reference || null, p.received_at || null, req.user.id, p.notes || null]);
      await audit.fromReq(req, { action: p.kind === 'refund' ? 'booking.refund' : 'booking.payment', entityType: 'booking', entityId: id, after: { payment_id: pay.id, amount: p.amount, method: p.method } }, c);
    }, { type: 'agent', userId: req.user.id });
  } catch (err) {
    if (err.code === '23505') throw conflict('A payment with this reference is already recorded');
    throw err;
  }
  const after = await get(req.user.tenantId, id);
  let confirmation = null;
  if (after.status === 'advance_pending' && after.advance_status === 'paid') {
    const r = await setStatus(req, id, { status: 'confirmed' });
    confirmation = r.confirmation;
    return { booking: r.booking, confirmation };
  }
  await bus.publish({ tenantId: req.user.tenantId, type: 'booking.updated', booking_id: id });
  return { booking: after, confirmation };
}

const EDITABLE = ['event_date', 'event_time', 'setup_time', 'venue_address', 'guest_count', 'special_requests', 'internal_notes', 'assigned_user_id', 'advance_amount'];

async function update(req, id, patch, { allowOverCapacity = false } = {}) {
  const before = await get(req.user.tenantId, id);
  if (patch.advance_amount != null && patch.advance_amount > Number(before.agreed_price)) throw badRequest('Advance cannot be more than the agreed price');
  let capacity = null;
  if (patch.event_date && patch.event_date !== before.event_date && before.status !== 'cancelled') {
    capacity = await dateLoad(req.user.tenantId, patch.event_date, { excludeId: id });
    if (capacity.full && !allowOverCapacity) throw conflict(`${patch.event_date} already has ${capacity.count} bookings (daily limit ${capacity.max}).`, { code: 'capacity', ...capacity });
  }
  const fields = Object.keys(patch).filter((k) => EDITABLE.includes(k));
  if (!fields.length) return { booking: before };
  await withTx(async (c) => {
    await c.query(`UPDATE bookings SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...fields.map((f) => patch[f])]);
    if (patch.advance_amount != null) {
      // re-evaluate advance status against the new required amount
      await c.query(`UPDATE bookings SET advance_status = CASE WHEN advance_paid_amount <= 0 THEN 'pending' WHEN advance_paid_amount >= advance_amount THEN 'paid' ELSE 'partial' END WHERE id = $1`, [id]);
    }
    await audit.fromReq(req, { action: 'booking.update', entityType: 'booking', entityId: id,
      before: Object.fromEntries(fields.map((f) => [f, before[f]])), after: Object.fromEntries(fields.map((f) => [f, patch[f]])) }, c);
    await bus.publish({ tenantId: req.user.tenantId, type: 'booking.updated', booking_id: id }, c);
  });
  return { booking: await get(req.user.tenantId, id), capacity };
}

module.exports = { createFromQuote, get, board, setStatus, recordPayment, update, dateLoad, leadTimeOk, advanceFor, sendConfirmation, STATUSES };
