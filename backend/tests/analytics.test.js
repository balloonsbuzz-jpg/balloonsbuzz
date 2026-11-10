// M9: every KPI is checked against a hand-built fixture in its own tenant, so the numbers
// are exact and nothing other suites write can move them.
const { pool, signedIn } = require('./helpers');
const analytics = require('../src/analytics/analytics.service');

const FROM = '2026-03-01';
const TO = '2026-03-07';
const ist = (s) => `${s}+05:30`;
let T; // fixture tenant id
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function buildFixture() {
  const slug = `analytics-fx-${Date.now()}`;
  ({ id: T } = await one(`INSERT INTO tenants (slug, name) VALUES ($1, 'Analytics fixture') RETURNING id`, [slug]));
  const { id: acct } = await one(
    `INSERT INTO whatsapp_accounts (tenant_id, display_phone, phone_number_id, waba_id) VALUES ($1, '919000000001', $2, 'waba-fx') RETURNING id`, [T, `pn-${slug}`]);
  const { id: occ } = await one(`INSERT INTO occasions (tenant_id, key, name) VALUES ($1, 'birthday', 'Birthday') RETURNING id`, [T]);
  const { id: pkg } = await one(`INSERT INTO packages (tenant_id, key, name, price_min, price_max) VALUES ($1, 'fx_pkg', 'Fixture package', 5000, 12000) RETURNING id`, [T]);

  const contact = async (phone, name, source = 'whatsapp') =>
    (await one(`INSERT INTO contacts (tenant_id, phone, name, source) VALUES ($1,$2,$3,$4) RETURNING id`, [T, phone, name, source])).id;
  const conv = async (contactId, sandbox = false) =>
    (await one(`INSERT INTO conversations (tenant_id, contact_id, whatsapp_account_id, is_sandbox) VALUES ($1,$2,$3,$4) RETURNING id`,
      [T, contactId, sandbox ? null : acct, sandbox])).id;
  const C1 = await contact('919000000011', 'Asha');
  const C2 = await contact('919000000012', '=HYPERLINK("http://x"), Ravi');
  const C3 = await contact('919000000013', 'Meena');
  const C4 = await contact('919000000014', 'Kiran');
  const CS = await contact('919000000019', 'Sandbox tester', 'sandbox');
  const cv1 = await conv(C1); const cv2 = await conv(C2); const cv3 = await conv(C3); await conv(C4); const cvS = await conv(CS, true);

  const lead = async (contactId, convId, status, createdAt, extra = {}) => (await one(
    `INSERT INTO leads (tenant_id, contact_id, conversation_id, status, created_at, qualified_at, lost_reason, occasion_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [T, contactId, convId, status, ist(createdAt), extra.qualified ? ist(createdAt) : null, extra.lost || null, occ])).id;
  const L1 = await lead(C1, cv1, 'won', '2026-03-02 09:59:00', { qualified: true });
  const L2 = await lead(C2, cv2, 'quoted', '2026-03-03 08:00:00');
  await lead(C3, cv3, 'lost', '2026-03-04 09:00:00', { lost: 'Too expensive' });
  await lead(C4, null, 'stale', '2026-02-28 23:00:00'); // previous period
  await lead(C4, null, 'new', '2026-03-07 23:59:59'); // last second of the range
  await lead(CS, cvS, 'quoted', '2026-03-03 10:00:00'); // sandbox: never counted
  const quote = (leadId) => pool.query(
    `INSERT INTO quotes (tenant_id, lead_id, package_id, list_price, final_price, floor_price) VALUES ($1,$2,$3,12000,12000,10000)`, [T, leadId, pkg]);
  await quote(L1); await quote(L2);

  const booking = async (p) => (await one(
    `INSERT INTO bookings (tenant_id, lead_id, contact_id, package_id, occasion_id, event_date, venue_address, quoted_price, agreed_price, floor_price,
                           advance_amount, status, cancelled_reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'Venue',$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [T, p.lead || null, p.contact, pkg, occ, p.event, p.quoted, p.agreed, p.floor ?? p.agreed, p.advance || 0, p.status,
      p.status === 'cancelled' ? 'Changed plans' : null, ist(p.created)])).id;
  const B1 = await booking({ lead: L1, contact: C1, event: '2026-03-05', quoted: 12000, agreed: 11000, floor: 10000, advance: 3300, status: 'confirmed', created: '2026-03-02 12:00:00' });
  await booking({ contact: C2, event: '2026-03-20', quoted: 8000, agreed: 8000, status: 'cancelled', created: '2026-03-03 12:00:00' });
  const B3 = await booking({ contact: C3, event: '2026-03-06', quoted: 5000, agreed: 5000, status: 'advance_pending', created: '2026-03-08 00:30:00' });
  await booking({ contact: CS, event: '2026-03-05', quoted: 9000, agreed: 9000, status: 'confirmed', created: '2026-03-03 12:00:00' });
  const pay = (b, kind, amount, at) => pool.query(
    `INSERT INTO booking_payments (tenant_id, booking_id, kind, amount, method, received_at) VALUES ($1,$2,$3,$4,'upi',$5)`, [T, b, kind, amount, ist(at)]);
  await pay(B1, 'payment', 3300, '2026-03-02 13:00:00');
  await pay(B1, 'refund', 300, '2026-03-04 10:00:00');
  await pay(B3, 'payment', 1000, '2026-03-09 10:00:00');

  const contactOf = { [cv1]: C1, [cv2]: C2, [cv3]: C3, [cvS]: CS };
  const msg = (cv, sender, at, extra = {}) => pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, message_type, body, status, is_internal_note, created_at)
     VALUES ($1,$2,$3,$4,$5,'text','x',$6,$7,$8)`,
    [T, cv, contactOf[cv], sender === 'customer' ? 'inbound' : 'outbound', sender,
      extra.status || (sender === 'customer' ? 'received' : 'sent'), !!extra.note, ist(at)]);
  await msg(cv1, 'customer', '2026-03-02 10:00:00');
  await msg(cv1, 'customer', '2026-03-02 10:00:30'); // same turn
  await msg(cv1, 'bot', '2026-03-02 10:01:00'); // 60 s
  await msg(cv1, 'customer', '2026-03-02 11:00:00');
  await msg(cv1, 'agent', '2026-03-02 11:01:00', { note: true }); // internal note, not a reply
  await msg(cv1, 'agent', '2026-03-02 11:05:00'); // 300 s
  await msg(cv2, 'customer', '2026-03-03 09:00:00');
  await msg(cv2, 'bot', '2026-03-03 09:00:10', { status: 'failed' }); // never reached the customer
  await msg(cv2, 'bot', '2026-03-03 09:00:20'); // 20 s
  await msg(cv2, 'customer', '2026-03-03 09:30:00'); // unanswered
  await msg(cv3, 'customer', '2026-03-04 10:00:00');
  await msg(cv3, 'agent', '2026-03-04 10:10:00'); // 600 s
  await msg(cvS, 'customer', '2026-03-03 10:00:00');
  await msg(cvS, 'bot', '2026-03-03 10:00:01');

  const hand = (cv, from, to, trigger, at) => pool.query(
    `INSERT INTO handover_events (tenant_id, conversation_id, from_mode, to_mode, trigger, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [T, cv, from, to, trigger, ist(at)]);
  await hand(cv1, 'bot', 'human', 'keyword', '2026-03-02 10:30:00');
  await hand(cv1, 'human', 'bot', 'agent_resume', '2026-03-02 10:40:00');
  await hand(cv3, 'bot', 'human', 'agent_takeover', '2026-03-04 10:05:00');
  await hand(cv3, 'human', 'paused', 'agent_pause', '2026-03-04 10:20:00');
  await hand(cvS, 'bot', 'human', 'keyword', '2026-03-03 10:00:05');

  const run = (cv, cost, outcome, at, tokens = [0, 0], latency = null) => pool.query(
    `INSERT INTO ai_runs (tenant_id, conversation_id, provider, model, cost_inr, outcome, input_tokens, output_tokens, latency_ms, created_at)
     VALUES ($1,$2,'deepseek','m',$3,$4,$5,$6,$7,$8)`, [T, cv, cost, outcome, tokens[0], tokens[1], latency, ist(at)]);
  await run(cv1, 0.5, 'replied', '2026-03-02 10:00:40', [100, 50], 2000);
  await run(cv2, 0.25, 'blocked', '2026-03-03 09:00:05', [10, 10]);
  await run(cvS, 1.0, 'replied', '2026-03-03 10:00:00', [500, 500], 900);
  await run(cv1, 5, 'replied', '2026-03-09 10:00:00');
}

let owner; let agent;
beforeAll(async () => {
  await buildFixture();
  owner = await signedIn('owner');
  agent = await signedIn('agent');
});
afterAll(() => pool.end());

describe('KPIs match the SQL fixture', () => {
  let r;
  beforeAll(async () => { r = await analytics.report(T, { from: FROM, to: TO }); });

  test('range and previous period', () => {
    expect(r.range).toEqual({ from: FROM, to: TO, days: 7, timezone: 'Asia/Kolkata' });
    expect(r.previous_range).toEqual({ from: '2026-02-22', to: '2026-02-28' });
    expect(r.previous.funnel.leads).toBe(1); // the 23:00 IST lead on 28 Feb
  });

  test('funnel: enquiries → qualified → quoted → booked (sandbox excluded, IST day edges)', () => {
    expect(r.funnel).toEqual({ leads: 4, qualified: 2, quoted: 2, booked: 1, lost: 1, conversion_pct: 25 });
  });

  test('bookings, money collected (refunds netted) and events in the range', () => {
    expect(r.bookings).toEqual({ count: 1, cancelled: 1, by_bot: 1, booked_value: 11000, avg_value: 11000, discount_given: 1000, collected: 3000, payments: 1 });
    expect(r.events).toEqual({ count: 2, value: 16000, completed: 0, balance_due: 12000 });
  });

  test('response time: one turn per customer burst, notes and failed sends ignored', () => {
    expect(r.response).toEqual({
      turns: 5, answered: 4, unanswered: 1, median_secs: 180, p90_secs: 510,
      bot_median_secs: 40, team_median_secs: 450, by_bot: 2, by_team: 2,
    });
  });

  test('handover rate and triggers', () => {
    expect(r.handover).toEqual({ active_chats: 3, handed_chats: 2, escalated_chats: 1, team_stepped_in_chats: 1, rate_pct: 66.7 });
    expect(r.breakdowns.handover_triggers).toEqual(expect.arrayContaining([
      { trigger: 'keyword', n: 1 }, { trigger: 'agent_takeover', n: 1 }, { trigger: 'agent_pause', n: 1 }]));
    expect(r.breakdowns.handover_triggers).toHaveLength(3);
  });

  test('AI cost: live chats only, test-console cost shown apart', () => {
    expect(r.ai).toEqual({ runs: 2, cost: 0.75, sandbox_cost: 1, sandbox_runs: 1, blocked: 1, errors: 0, tokens: 170, avg_latency_ms: 2000, cost_per_booking: 0.75 });
  });

  test('daily series has every day and adds up to the totals', () => {
    expect(r.daily.map((d) => d.day)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07']);
    expect(r.daily[1]).toEqual({ day: '2026-03-02', leads: 1, bookings: 1, booked_value: 11000, collected: 3300, ai_cost: 0.5 });
    expect(r.daily[3]).toMatchObject({ day: '2026-03-04', leads: 1, collected: -300 });
    const sum = (k) => r.daily.reduce((s, d) => s + d[k], 0);
    expect(sum('leads')).toBe(r.funnel.leads);
    expect(sum('bookings')).toBe(r.bookings.count);
    expect(sum('collected')).toBe(r.bookings.collected);
    expect(sum('ai_cost')).toBeCloseTo(r.ai.cost);
  });

  test('breakdowns', () => {
    expect(r.breakdowns.occasions).toEqual([{ name: 'Birthday', bookings: 1, value: 11000 }]);
    expect(r.breakdowns.packages).toEqual([{ name: 'Fixture package', bookings: 1, value: 11000 }]);
    expect(r.breakdowns.lost_reasons).toEqual([{ reason: 'Too expensive', n: 1 }]);
  });
});

describe('CSV', () => {
  test('bookings CSV: no phone numbers, formula cells neutralised, commas quoted', async () => {
    const out = await analytics.exportCsv(T, 'bookings', { from: FROM, to: TO });
    const lines = out.csv.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + B1 + cancelled B2 (sandbox and out-of-range left out)
    expect(lines[0]).not.toMatch(/phone/);
    expect(out.csv).not.toMatch(/919000/);
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://x""), Ravi"`);
    expect(lines[1]).toMatch(/^BB-\d+,2026-03-02 12:00,2026-03-05,,confirmed,Asha,Birthday,Fixture package,,bot,12000.00,11000.00/);
  });

  test('daily CSV matches the daily series', async () => {
    const out = await analytics.exportCsv(T, 'daily', { from: FROM, to: TO });
    const lines = out.csv.trim().split('\r\n');
    expect(lines[0]).toBe('day,leads,bookings,booked_value,collected,ai_cost');
    expect(lines[2]).toBe('2026-03-02,1,1,11000,3300,0.5');
    expect(lines).toHaveLength(8);
    expect(out.filename).toBe('balloonsbuzz-daily-2026-03-01-to-2026-03-07.csv');
  });

  test('toCsv keeps negative numbers as numbers', () => {
    expect(analytics.toCsv([{ a: -300, b: '-x', c: '+91' }], ['a', 'b', 'c'])).toBe(`a,b,c\r\n-300,'-x,'+91\r\n`);
  });
});

describe('API', () => {
  test('owner gets the report; date range is validated', async () => {
    const ok = await owner.get(`/api/analytics?from=${FROM}&to=${TO}`);
    expect(ok.status).toBe(200);
    expect(ok.body.range.days).toBe(7);
    expect(Array.isArray(ok.body.daily)).toBe(true);
    expect((await owner.get('/api/analytics?from=2026-03-07&to=2026-03-01')).status).toBe(400);
    expect((await owner.get('/api/analytics?from=2024-01-01&to=2026-03-01')).body.error).toMatch(/366/);
    expect((await owner.get('/api/analytics?from=2026-13-45')).status).toBe(400);
    const def = await owner.get('/api/analytics');
    expect(def.body.range.days).toBe(30);
  });

  test('export downloads CSV and is written to the audit log', async () => {
    const res = await owner.get(`/api/analytics/export?kind=bookings&from=${FROM}&to=${TO}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/balloonsbuzz-bookings-2026-03-01-to-2026-03-07\.csv/);
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
    const a = await one(`SELECT after FROM audit_log WHERE action = 'analytics.export' AND actor_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [owner.user.id]);
    expect(a.after).toMatchObject({ kind: 'bookings', from: FROM, to: TO });
    expect((await owner.get('/api/analytics/export?kind=contacts')).status).toBe(400);
  });

  test('agents see the dashboard but not analytics or exports', async () => {
    const d = await agent.get('/api/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.counts).toEqual(expect.objectContaining({ needs_human: expect.any(Number), open_leads: expect.any(Number), advance_pending: expect.any(Number) }));
    expect(Array.isArray(d.body.upcoming)).toBe(true);
    expect((await agent.get('/api/analytics')).status).toBe(403);
    expect((await agent.get('/api/analytics/export')).status).toBe(403);
  });

  test('the dashboard lists the next 7 days of events for this tenant only', async () => {
    const today = analytics.todayIn('Asia/Kolkata');
    const o = await analytics.overview(T);
    expect(o.today).toBe(today);
    expect(o.upcoming).toEqual([]); // fixture events are in March, far from today
    expect(o.counts.open_leads).toBe(2); // L2 (quoted) + the 'new' lead; sandbox excluded
  });
});
