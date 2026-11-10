// M9 analytics. Every number is one SQL aggregate over the tenant's own rows, for a
// date range of whole days in the tenant's timezone (IST). Test-console (sandbox)
// chats are always left out of business numbers; their AI cost is reported apart.
const { query } = require('../db/pool');
const { badRequest } = require('../lib/errors');

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;

const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => isoDay(new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY_MS));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS) + 1;

/** Today's date in a timezone, as YYYY-MM-DD. */
function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function tenantTz(tenantId) {
  const { rows: [t] } = await query(`SELECT timezone FROM tenants WHERE id = $1`, [tenantId]);
  return t?.timezone || 'Asia/Kolkata';
}

/**
 * Normalise a range. Defaults to the last 30 days ending today. Returns the equal-length
 * period just before it too, for "vs previous period" deltas.
 */
function resolveRange({ from, to } = {}, tz = 'Asia/Kolkata') {
  const end = to || todayIn(tz);
  const start = from || addDays(end, -29);
  if (start > end) throw badRequest('The start date is after the end date');
  const days = daysBetween(start, end);
  if (days > MAX_DAYS) throw badRequest(`Pick a range of at most ${MAX_DAYS} days`);
  return { from: start, to: end, days, previous: { from: addDays(start, -days), to: addDays(start, -1) } };
}

// $1 tenant, $2 from (date), $3 to (date, inclusive), $4 timezone
const START = `(($2::date)::timestamp AT TIME ZONE $4)`;
const END = `((($3::date) + 1)::timestamp AT TIME ZONE $4)`;
const IN_RANGE = (col) => `${col} >= ${START} AND ${col} < ${END}`;
const NOT_SANDBOX = `ct.source <> 'sandbox'`;

const num = (v) => (v == null ? 0 : Number(v));
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** Headline numbers for one range (used for the range and its previous period). */
async function headline(tenantId, from, to, tz) {
  const p = [tenantId, from, to, tz];
  const [funnel, booked, collected, events, resp, hand, ai] = await Promise.all([
    query(`
      SELECT count(*)::int AS leads,
             count(*) FILTER (WHERE l.qualified_at IS NOT NULL OR q.has_quote OR b.has_booking)::int AS qualified,
             count(*) FILTER (WHERE q.has_quote OR b.has_booking)::int AS quoted,
             count(*) FILTER (WHERE b.has_booking)::int AS booked,
             count(*) FILTER (WHERE l.status = 'lost')::int AS lost
        FROM leads l JOIN contacts ct ON ct.id = l.contact_id
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM quotes q WHERE q.lead_id = l.id) AS has_quote) q
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM bookings b WHERE b.lead_id = l.id AND b.deleted_at IS NULL AND b.status <> 'cancelled') AS has_booking) b
       WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND ${NOT_SANDBOX} AND ${IN_RANGE('l.created_at')}`, p),
    query(`
      SELECT count(*) FILTER (WHERE b.status <> 'cancelled')::int AS bookings,
             count(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled,
             count(*) FILTER (WHERE b.status <> 'cancelled' AND b.created_by_type = 'bot')::int AS by_bot,
             coalesce(sum(b.agreed_price) FILTER (WHERE b.status <> 'cancelled'), 0) AS booked_value,
             coalesce(sum(b.quoted_price - b.agreed_price) FILTER (WHERE b.status <> 'cancelled'), 0) AS discount_given
        FROM bookings b JOIN contacts ct ON ct.id = b.contact_id
       WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND ${NOT_SANDBOX} AND ${IN_RANGE('b.created_at')}`, p),
    query(`
      SELECT coalesce(sum(CASE WHEN bp.kind = 'payment' THEN bp.amount ELSE -bp.amount END), 0) AS collected,
             count(*) FILTER (WHERE bp.kind = 'payment')::int AS payments
        FROM booking_payments bp JOIN bookings b ON b.id = bp.booking_id JOIN contacts ct ON ct.id = b.contact_id
       WHERE bp.tenant_id = $1 AND b.deleted_at IS NULL AND ${NOT_SANDBOX} AND ${IN_RANGE('bp.received_at')}`, p),
    query(`
      SELECT count(*)::int AS events, coalesce(sum(b.agreed_price), 0) AS events_value,
             count(*) FILTER (WHERE b.status = 'completed')::int AS completed,
             coalesce(sum(b.balance_amount) FILTER (WHERE b.status <> 'completed'), 0) AS balance_due
        FROM bookings b JOIN contacts ct ON ct.id = b.contact_id
       WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND b.status <> 'cancelled' AND ${NOT_SANDBOX}
         AND b.event_date BETWEEN $2::date AND $3::date AND $4::text IS NOT NULL`, p),
    // A "customer turn" is an inbound message whose previous (non-note, non-system) message
    // in the chat was not also from the customer. Its response time is the gap to the first
    // bot/agent message that actually went out after it.
    query(`
      WITH m AS (
        SELECT msg.id, msg.conversation_id, msg.direction, msg.created_at,
               lag(msg.direction) OVER (PARTITION BY msg.conversation_id ORDER BY msg.created_at, msg.id) AS prev_dir
          FROM messages msg JOIN conversations cv ON cv.id = msg.conversation_id
         WHERE msg.tenant_id = $1 AND NOT cv.is_sandbox AND NOT msg.is_internal_note AND msg.sender_type <> 'system'
           AND msg.created_at >= ${START} - interval '2 days' AND msg.created_at < ${END}
      ), turns AS (
        SELECT m.id, extract(epoch FROM r.created_at - m.created_at) AS secs, r.sender_type AS by
          FROM m LEFT JOIN LATERAL (
            SELECT o.created_at, o.sender_type FROM messages o
             WHERE o.conversation_id = m.conversation_id AND o.direction = 'outbound' AND o.sender_type IN ('bot','agent')
               AND NOT o.is_internal_note AND o.message_type <> 'template' AND o.status NOT IN ('failed','cancelled')
               AND o.created_at >= m.created_at
             ORDER BY o.created_at LIMIT 1) r ON true
         WHERE m.direction = 'inbound' AND m.prev_dir IS DISTINCT FROM 'inbound' AND ${IN_RANGE('m.created_at')}
      )
      SELECT count(*)::int AS turns, count(secs)::int AS answered,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS median_secs,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) AS p90_secs,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FILTER (WHERE by = 'bot') AS bot_median_secs,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FILTER (WHERE by = 'agent') AS team_median_secs,
             count(*) FILTER (WHERE by = 'bot')::int AS by_bot, count(*) FILTER (WHERE by = 'agent')::int AS by_team
        FROM turns`, p),
    query(`
      WITH active AS (
        SELECT DISTINCT msg.conversation_id FROM messages msg JOIN conversations cv ON cv.id = msg.conversation_id
         WHERE msg.tenant_id = $1 AND NOT cv.is_sandbox AND msg.direction = 'inbound' AND ${IN_RANGE('msg.created_at')}
      ), ev AS (
        SELECT he.conversation_id, he.trigger FROM handover_events he JOIN conversations cv ON cv.id = he.conversation_id
         WHERE he.tenant_id = $1 AND NOT cv.is_sandbox AND he.to_mode <> 'bot' AND ${IN_RANGE('he.created_at')}
      )
      SELECT (SELECT count(*) FROM active)::int AS active_chats,
             (SELECT count(DISTINCT conversation_id) FROM ev WHERE trigger NOT LIKE 'agent\\_%')::int AS escalated_chats,
             (SELECT count(DISTINCT conversation_id) FROM ev WHERE trigger LIKE 'agent\\_%')::int AS team_stepped_in_chats,
             (SELECT count(DISTINCT conversation_id) FROM ev)::int AS handed_chats`, p),
    query(`
      SELECT count(*) FILTER (WHERE NOT cv.is_sandbox)::int AS runs,
             coalesce(sum(r.cost_inr) FILTER (WHERE NOT cv.is_sandbox), 0) AS cost,
             coalesce(sum(r.cost_inr) FILTER (WHERE cv.is_sandbox), 0) AS sandbox_cost,
             count(*) FILTER (WHERE cv.is_sandbox)::int AS sandbox_runs,
             count(*) FILTER (WHERE NOT cv.is_sandbox AND r.outcome = 'blocked')::int AS blocked,
             count(*) FILTER (WHERE NOT cv.is_sandbox AND r.outcome = 'error')::int AS errors,
             coalesce(sum(r.input_tokens + r.output_tokens) FILTER (WHERE NOT cv.is_sandbox), 0)::bigint AS tokens,
             avg(r.latency_ms) FILTER (WHERE NOT cv.is_sandbox AND r.outcome = 'replied') AS avg_latency_ms
        FROM ai_runs r JOIN conversations cv ON cv.id = r.conversation_id
       WHERE r.tenant_id = $1 AND ${IN_RANGE('r.created_at')}`, p),
  ]);

  const f = funnel.rows[0]; const bk = booked.rows[0]; const c = collected.rows[0];
  const ev = events.rows[0]; const r = resp.rows[0]; const h = hand.rows[0]; const a = ai.rows[0];
  const bookings = bk.bookings; const bookedValue = num(bk.booked_value); const aiCost = num(a.cost);
  const round = (v) => (v == null ? null : Math.round(Number(v)));
  return {
    funnel: { leads: f.leads, qualified: f.qualified, quoted: f.quoted, booked: f.booked, lost: f.lost, conversion_pct: pct(f.booked, f.leads) },
    bookings: {
      count: bookings, cancelled: bk.cancelled, by_bot: bk.by_bot, booked_value: bookedValue,
      avg_value: bookings ? Math.round(bookedValue / bookings) : null, discount_given: num(bk.discount_given),
      collected: num(c.collected), payments: c.payments,
    },
    events: { count: ev.events, value: num(ev.events_value), completed: ev.completed, balance_due: num(ev.balance_due) },
    response: {
      turns: r.turns, answered: r.answered, unanswered: r.turns - r.answered,
      median_secs: round(r.median_secs), p90_secs: round(r.p90_secs),
      bot_median_secs: round(r.bot_median_secs), team_median_secs: round(r.team_median_secs), by_bot: r.by_bot, by_team: r.by_team,
    },
    handover: {
      active_chats: h.active_chats, handed_chats: h.handed_chats, escalated_chats: h.escalated_chats, team_stepped_in_chats: h.team_stepped_in_chats,
      rate_pct: pct(h.handed_chats, h.active_chats),
    },
    ai: {
      runs: a.runs, cost: Math.round(aiCost * 100) / 100, sandbox_cost: Math.round(num(a.sandbox_cost) * 100) / 100, sandbox_runs: a.sandbox_runs,
      blocked: a.blocked, errors: a.errors, tokens: Number(a.tokens), avg_latency_ms: round(a.avg_latency_ms),
      cost_per_booking: bookings ? Math.round((aiCost / bookings) * 100) / 100 : null,
    },
  };
}

/** One row per day: enquiries, bookings, booked value, money collected, AI cost. */
async function daily(tenantId, from, to, tz) {
  const { rows } = await query(`
    WITH d AS (SELECT gs::date AS day FROM generate_series($2::date, $3::date, interval '1 day') gs),
    l AS (SELECT (l.created_at AT TIME ZONE $4)::date AS day, count(*)::int AS n FROM leads l JOIN contacts ct ON ct.id = l.contact_id
           WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND ${NOT_SANDBOX} AND ${IN_RANGE('l.created_at')} GROUP BY 1),
    b AS (SELECT (b.created_at AT TIME ZONE $4)::date AS day, count(*)::int AS n, sum(b.agreed_price) AS v FROM bookings b JOIN contacts ct ON ct.id = b.contact_id
           WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND b.status <> 'cancelled' AND ${NOT_SANDBOX} AND ${IN_RANGE('b.created_at')} GROUP BY 1),
    p AS (SELECT (bp.received_at AT TIME ZONE $4)::date AS day, sum(CASE WHEN bp.kind = 'payment' THEN bp.amount ELSE -bp.amount END) AS v
            FROM booking_payments bp JOIN bookings b ON b.id = bp.booking_id JOIN contacts ct ON ct.id = b.contact_id
           WHERE bp.tenant_id = $1 AND b.deleted_at IS NULL AND ${NOT_SANDBOX} AND ${IN_RANGE('bp.received_at')} GROUP BY 1),
    a AS (SELECT (r.created_at AT TIME ZONE $4)::date AS day, sum(r.cost_inr) AS v FROM ai_runs r JOIN conversations cv ON cv.id = r.conversation_id
           WHERE r.tenant_id = $1 AND NOT cv.is_sandbox AND ${IN_RANGE('r.created_at')} GROUP BY 1)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(l.n, 0) AS leads, coalesce(b.n, 0) AS bookings,
           coalesce(b.v, 0) AS booked_value, coalesce(p.v, 0) AS collected, round(coalesce(a.v, 0), 2) AS ai_cost
      FROM d LEFT JOIN l USING (day) LEFT JOIN b USING (day) LEFT JOIN p USING (day) LEFT JOIN a USING (day)
     ORDER BY d.day`, [tenantId, from, to, tz]);
  return rows.map((x) => ({ ...x, booked_value: num(x.booked_value), collected: num(x.collected), ai_cost: num(x.ai_cost) }));
}

/** What sells and why chats go to the team. */
async function breakdowns(tenantId, from, to, tz) {
  const p = [tenantId, from, to, tz];
  const by = (joinCol, table) => query(`
    SELECT coalesce(x.name, 'Not set') AS name, count(*)::int AS bookings, sum(b.agreed_price) AS value
      FROM bookings b JOIN contacts ct ON ct.id = b.contact_id LEFT JOIN ${table} x ON x.id = b.${joinCol}
     WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND b.status <> 'cancelled' AND ${NOT_SANDBOX} AND ${IN_RANGE('b.created_at')} AND $4::text IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 8`, p);
  const [occasions, packages, themes, triggers, lost] = await Promise.all([
    by('occasion_id', 'occasions'), by('package_id', 'packages'), by('theme_id', 'themes'),
    query(`SELECT he.trigger, count(*)::int AS n FROM handover_events he JOIN conversations cv ON cv.id = he.conversation_id
            WHERE he.tenant_id = $1 AND NOT cv.is_sandbox AND he.to_mode <> 'bot' AND ${IN_RANGE('he.created_at')}
            GROUP BY 1 ORDER BY 2 DESC`, p),
    query(`SELECT coalesce(nullif(trim(l.lost_reason), ''), 'No reason') AS reason, count(*)::int AS n
             FROM leads l JOIN contacts ct ON ct.id = l.contact_id
            WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND l.status = 'lost' AND ${NOT_SANDBOX} AND ${IN_RANGE('l.created_at')}
            GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, p),
  ]);
  const money = (rows) => rows.map((r) => ({ ...r, value: num(r.value) }));
  return { occasions: money(occasions.rows), packages: money(packages.rows), themes: money(themes.rows), handover_triggers: triggers.rows, lost_reasons: lost.rows };
}

async function report(tenantId, range = {}) {
  const tz = await tenantTz(tenantId);
  const r = resolveRange(range, tz);
  const [current, previous, days, top] = await Promise.all([
    headline(tenantId, r.from, r.to, tz), headline(tenantId, r.previous.from, r.previous.to, tz),
    daily(tenantId, r.from, r.to, tz), breakdowns(tenantId, r.from, r.to, tz),
  ]);
  return { range: { from: r.from, to: r.to, days: r.days, timezone: tz }, previous_range: r.previous, ...current, previous, daily: days, breakdowns: top };
}

/** The bookings created in the range, one row each (no phone numbers). */
async function bookingRows(tenantId, from, to, tz) {
  const { rows } = await query(`
    SELECT b.booking_code, to_char(b.created_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI') AS created_at,
           to_char(b.event_date, 'YYYY-MM-DD') AS event_date, to_char(b.event_time, 'HH24:MI') AS event_time, b.status,
           ct.name AS customer, o.name AS occasion, pk.name AS package, t.name AS theme, b.created_by_type AS booked_by,
           b.quoted_price, b.agreed_price, b.distance_charge, b.advance_amount, b.advance_paid_amount, b.balance_amount, b.advance_status
      FROM bookings b JOIN contacts ct ON ct.id = b.contact_id LEFT JOIN occasions o ON o.id = b.occasion_id
      LEFT JOIN packages pk ON pk.id = b.package_id LEFT JOIN themes t ON t.id = b.theme_id
     WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND ${NOT_SANDBOX} AND ${IN_RANGE('b.created_at')}
     ORDER BY b.created_at`, [tenantId, from, to, tz]);
  return rows;
}

/** CSV with spreadsheet-formula injection neutralised. */
function toCsv(rows, columns) {
  const cell = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  return `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n')}\r\n`;
}

const DAILY_COLUMNS = ['day', 'leads', 'bookings', 'booked_value', 'collected', 'ai_cost'];
const BOOKING_COLUMNS = ['booking_code', 'created_at', 'event_date', 'event_time', 'status', 'customer', 'occasion', 'package', 'theme', 'booked_by',
  'quoted_price', 'agreed_price', 'distance_charge', 'advance_amount', 'advance_paid_amount', 'balance_amount', 'advance_status'];

async function exportCsv(tenantId, kind, range = {}) {
  const tz = await tenantTz(tenantId);
  const r = resolveRange(range, tz);
  const rows = kind === 'bookings' ? await bookingRows(tenantId, r.from, r.to, tz) : await daily(tenantId, r.from, r.to, tz);
  return { csv: toCsv(rows, kind === 'bookings' ? BOOKING_COLUMNS : DAILY_COLUMNS), rows: rows.length, filename: `balloonsbuzz-${kind}-${r.from}-to-${r.to}.csv`, range: r };
}

/** Today at a glance, for everyone on the team (Dashboard). */
async function overview(tenantId) {
  const tz = await tenantTz(tenantId);
  const today = todayIn(tz);
  const p = [tenantId, today, today, tz];
  const [counts, upcoming, month] = await Promise.all([
    query(`
      SELECT (SELECT count(*) FROM conversations cv WHERE cv.tenant_id = $1 AND NOT cv.is_sandbox AND cv.needs_human)::int AS needs_human,
             (SELECT count(*) FROM conversations cv WHERE cv.tenant_id = $1 AND NOT cv.is_sandbox AND cv.unread_count > 0)::int AS unread_chats,
             (SELECT count(*) FROM leads l JOIN contacts ct ON ct.id = l.contact_id WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND ${NOT_SANDBOX}
                 AND l.status IN ('new','qualifying','quoted','negotiating'))::int AS open_leads,
             (SELECT count(*) FROM leads l JOIN contacts ct ON ct.id = l.contact_id WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND ${NOT_SANDBOX}
                 AND ${IN_RANGE('l.created_at')})::int AS leads_today,
             (SELECT count(*) FROM bookings b JOIN contacts ct ON ct.id = b.contact_id WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND ${NOT_SANDBOX}
                 AND b.status <> 'cancelled' AND ${IN_RANGE('b.created_at')})::int AS bookings_today,
             (SELECT count(*) FROM bookings b JOIN contacts ct ON ct.id = b.contact_id WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND ${NOT_SANDBOX}
                 AND b.status = 'advance_pending')::int AS advance_pending,
             (SELECT coalesce(sum(b.advance_amount - b.advance_paid_amount), 0) FROM bookings b JOIN contacts ct ON ct.id = b.contact_id
               WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND ${NOT_SANDBOX} AND b.status = 'advance_pending') AS advance_pending_amount,
             (SELECT count(*) FROM followups f WHERE f.tenant_id = $1 AND f.status = 'pending')::int AS followups_waiting,
             (SELECT is_enabled FROM ai_agent_config WHERE tenant_id = $1 LIMIT 1) AS bot_enabled`, p),
    query(`
      SELECT b.id, b.booking_code, to_char(b.event_date, 'YYYY-MM-DD') AS event_date, to_char(b.event_time, 'HH24:MI') AS event_time,
             b.status, b.advance_status, b.balance_amount, b.venue_address, ct.name AS contact_name, pk.name AS package_name, o.name AS occasion_name
        FROM bookings b JOIN contacts ct ON ct.id = b.contact_id LEFT JOIN packages pk ON pk.id = b.package_id LEFT JOIN occasions o ON o.id = b.occasion_id
       WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND ${NOT_SANDBOX} AND b.status IN ('advance_pending','confirmed')
         AND b.event_date BETWEEN $2::date AND $2::date + 6 AND $3::date IS NOT NULL AND $4::text IS NOT NULL
       ORDER BY b.event_date, b.event_time NULLS LAST LIMIT 20`, p),
    headline(tenantId, `${today.slice(0, 8)}01`, today, tz),
  ]);
  const c = counts.rows[0];
  return {
    today, timezone: tz,
    counts: { ...c, advance_pending_amount: num(c.advance_pending_amount) },
    upcoming: upcoming.rows.map((b) => ({ ...b, balance_amount: num(b.balance_amount) })),
    month: { from: `${today.slice(0, 8)}01`, to: today, funnel: month.funnel, bookings: month.bookings, handover: month.handover, response: month.response },
  };
}

module.exports = { report, overview, exportCsv, headline, daily, breakdowns, resolveRange, toCsv, todayIn };
