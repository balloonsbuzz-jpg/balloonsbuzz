// M7: bookings from chat, the board, payments + confirmation, capacity, leads.
const { pool, signedIn } = require('./helpers');
const { startMockLlm, say, call, toolResult, inr } = require('./mock-llm');
const { startMockGraph } = require('./mock-graph');
const { postWebhook, inboundText, ensureAccount } = require('./wa-helpers');
const { createWorker } = require('../src/queue/worker-loop');
const handlers = require('../src/queue/handlers');
const { HANDLERS } = require('../src/agent/tools/handlers');
const bus = require('../src/realtime/bus');

let llm; let graph; let owner; let agent; let tenantId; let worker;
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const drain = () => worker.drain({ timeoutMs: 30_000 });
const FAR_DATE = '2027-02-20';
let seq = 0;

async function chat(text) {
  const res = await owner.post('/api/agent/sandbox/messages', { text });
  if (res.status !== 200) throw new Error(`sandbox ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A real WhatsApp conversation with a quote for `packageKey`, without the LLM. */
async function whatsappQuote(packageKey = 'semi_arch') {
  seq += 1;
  const phone = `9198600${String(Date.now()).slice(-4)}${seq}`.slice(0, 12);
  // the bot stays out of these chats (its scripted replies belong to the sandbox tests)
  await pool.query(`UPDATE ai_agent_config SET is_enabled = false`);
  try {
    await postWebhook(inboundText(`wamid.BK${Date.now()}${seq}`, 'Hi, want to book', phone, `Booker ${seq}`));
    await drain();
  } finally {
    await pool.query(`UPDATE ai_agent_config SET is_enabled = true`);
  }
  const { id: conversationId } = await one(`SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.phone = $1`, [phone]);
  const ctx = { tenantId, conversationId, runId: null, allowed: new Set(), nextDelay: () => 0, toolConfig: {} };
  const q = await HANDLERS.get_pricing({ package_key: packageKey }, ctx);
  return { conversationId, quoteId: q.quote_id, phone, total: q.total_price };
}

beforeAll(async () => {
  llm = await startMockLlm(Number(process.env.LLM_MOCK_PORT));
  graph = await startMockGraph(Number(process.env.GRAPH_MOCK_PORT));
  owner = await signedIn('owner');
  agent = await signedIn('agent');
  ({ id: tenantId } = await one(`SELECT id FROM tenants WHERE slug = 'balloonsbuzz'`));
  await ensureAccount(owner);
  worker = createWorker({ handlers, concurrency: 4, pollMs: 50 });
  await pool.query(
    `UPDATE ai_agent_config SET is_enabled = true, base_url = $1, model = 'mock-model', fallback_model = NULL, response_delay_min_ms = 0, response_delay_max_ms = 0`,
    [`http://127.0.0.1:${process.env.LLM_MOCK_PORT}`]);
  await pool.query(`UPDATE negotiation_rules SET max_discount_pct = 10, max_discount_amount = NULL, min_final_price = NULL, concession_step_pct = 5, max_rounds = 2 WHERE tenant_id = $1 AND scope = 'global'`, [tenantId]);
  await pool.query(`UPDATE business_settings SET advance_type = 'percent', advance_value = 30, upi_vpa = 'balloonsbuzz@okhdfc', upi_payee_name = 'BalloonsBuzz',
                      max_bookings_per_day = NULL, min_lead_time_hours = 24 WHERE tenant_id = $1`, [tenantId]);
});

afterAll(async () => {
  await pool.query(`UPDATE ai_agent_config SET is_enabled = false, base_url = NULL`);
  await pool.query(`UPDATE business_settings SET max_bookings_per_day = NULL WHERE tenant_id = $1`, [tenantId]);
  await bus.stop(); await llm.close(); await graph.close(); await pool.end();
});

beforeEach(async () => {
  llm.reset(); graph.reset();
  const r = await owner.post('/api/agent/sandbox/reset', {});
  if (r.status !== 200) throw new Error(`sandbox reset failed: ${r.status}`);
});

describe('database guarantees', () => {
  test('a booking below the floor price is refused by the database itself', async () => {
    const { quoteId } = await whatsappQuote();
    const q = await one(`SELECT q.*, l.contact_id FROM quotes q JOIN leads l ON l.id = q.lead_id WHERE q.id = $1`, [quoteId]);
    await expect(pool.query(
      `INSERT INTO bookings (tenant_id, contact_id, package_id, event_date, venue_address, quoted_price, agreed_price, floor_price)
       VALUES ($1,$2,$3,$4,'Somewhere',$5,$6,$7)`,
      [tenantId, q.contact_id, q.package_id, FAR_DATE, q.final_price, Number(q.floor_price) - 1, q.floor_price])).rejects.toMatchObject({ constraint: 'bookings_floor_check' });
  });
});

describe('create_booking from chat', () => {
  test('creates an "advance pending" booking at the agreed price with the advance and UPI details', async () => {
    llm.script(call('get_pricing', { package_key: 'semi_arch' }), (b) => say(`Semi arch is ${inr(toolResult(b, 'get_pricing').total_price)} 🎈`));
    await chat('semi arch price?');
    llm.script(call('check_negotiation_limit', { requested_price: 9500 }), (b) => say(`Okay, ${inr(toolResult(b, 'check_negotiation_limit').price)} 😊`));
    await chat('9500?');
    llm.script(
      call('create_booking', { event_date: FAR_DATE, event_time: '17:00', venue_address: 'Flat 302, Kondapur', guest_count: 30 }),
      (b) => { const r = toolResult(b, 'create_booking'); return say(`Booked! ${r.booking_code}. Advance ${inr(r.advance_amount)} to ${r.pay_to.upi_id} 🙏`); },
    );
    const s = await chat('Yes please book it');
    expect(s.result.outcome).toBe('replied');

    const b = await one(`SELECT * FROM bookings WHERE lead_id = (SELECT id FROM leads WHERE conversation_id = $1)`, [s.conversation.id]);
    expect(b).toMatchObject({ status: 'advance_pending', advance_status: 'pending', event_date: FAR_DATE, venue_address: 'Flat 302, Kondapur', guest_count: 30, created_by_type: 'bot' });
    expect([Number(b.quoted_price), Number(b.agreed_price), Number(b.floor_price), Number(b.advance_amount)]).toEqual([10000, 9500, 9000, 2900]);  // 30% of 9500, up to ₹100
    const last = s.messages.filter((m) => m.direction === 'outbound' && !m.is_internal_note).at(-1).body;
    expect(last).toBe(`Booked! ${b.booking_code}. Advance ₹2,900 to balloonsbuzz@okhdfc 🙏`);
    expect(s.messages.some((m) => m.is_internal_note && m.body.includes(b.booking_code) && /Travel charge not included/.test(m.body))).toBe(true);
    expect(toolResult(llm.requests.at(-1).body, 'create_booking').travel_charge).toMatch(/team confirms/);
    expect((await one(`SELECT status FROM leads WHERE id = $1`, [b.lead_id])).status).toBe('won');
    expect((await one(`SELECT status FROM quotes WHERE id = $1`, [b.quote_id])).status).toBe('accepted');
    const hist = await one(`SELECT to_status, actor_type FROM booking_status_history WHERE booking_id = $1`, [b.id]);
    expect(hist).toEqual({ to_status: 'advance_pending', actor_type: 'bot' });
  });

  test('missing date or venue: the bot is told to ask first', async () => {
    llm.script(call('get_pricing', { package_key: 'basic' }), say('₹5,000'));
    await chat('basic?');
    llm.script(call('create_booking', {}), say('Which date and where? 📅'));
    await chat('book it');
    expect(toolResult(llm.requests.at(-1).body, 'create_booking').error).toMatch(/event date and venue address/);
  });

  test('an event too soon is handed to the team', async () => {
    llm.script(call('get_pricing', { package_key: 'basic' }), say('₹5,000'));
    await chat('basic?');
    const tomorrow = new Date(Date.now() + 5 * 3600_000 + 330 * 60_000).toISOString().slice(0, 10);
    llm.script(call('create_booking', { event_date: tomorrow, event_time: '06:00', venue_address: 'Miyapur' }), say('x'));
    const s = await chat('book for tomorrow morning');
    expect(s.result.outcome).toBe('handover');
    const ev = await one(`SELECT trigger FROM handover_events WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [s.conversation.id]);
    expect(ev.trigger).toBe('date_unavailable');
  });

  test('a full date is handed to the team instead of overbooking', async () => {
    await pool.query(`UPDATE business_settings SET max_bookings_per_day = 1 WHERE tenant_id = $1`, [tenantId]);
    try {
      const first = await whatsappQuote();
      const r1 = await owner.post('/api/bookings', { quote_id: first.quoteId, event_date: '2027-03-03', venue_address: 'Kukatpally' });
      expect(r1.status).toBe(201);
      llm.script(call('get_pricing', { package_key: 'basic' }), say('₹5,000'));
      await chat('basic?');
      llm.script(call('create_booking', { event_date: '2027-03-03', venue_address: 'Gachibowli' }), say('x'));
      const s = await chat('book 3 March');
      expect(s.result.outcome).toBe('handover');
      expect(s.messages.some((m) => m.is_internal_note && /fully booked \(1\/1\)/.test(m.body))).toBe(true);
    } finally {
      await pool.query(`UPDATE business_settings SET max_bookings_per_day = NULL WHERE tenant_id = $1`, [tenantId]);
    }
  });
});

describe('bookings API', () => {
  test('the team books from a quote; the same quote cannot be booked twice', async () => {
    const { quoteId } = await whatsappQuote();
    const r = await agent.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'Madhapur', guest_count: 50 });
    expect(r.status).toBe(201);
    expect(r.body.booking).toMatchObject({ status: 'advance_pending', created_by_type: 'agent', agreed_price: '10000.00', advance_amount: '3000.00' });
    expect((await agent.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'Madhapur' })).status).toBe(409);
  });

  test('capacity: a double-booked date warns, and can be overridden on purpose', async () => {
    await pool.query(`UPDATE business_settings SET max_bookings_per_day = 1 WHERE tenant_id = $1`, [tenantId]);
    try {
      const a = await whatsappQuote(); const b = await whatsappQuote();
      expect((await owner.post('/api/bookings', { quote_id: a.quoteId, event_date: '2027-04-04', venue_address: 'Address A' })).status).toBe(201);
      const warn = await owner.post('/api/bookings', { quote_id: b.quoteId, event_date: '2027-04-04', venue_address: 'Address B' });
      expect(warn.status).toBe(409);
      expect(warn.body).toMatchObject({ details: { code: 'capacity', count: 1, max: 1 } });
      const forced = await owner.post('/api/bookings', { quote_id: b.quoteId, event_date: '2027-04-04', venue_address: 'Address B', allow_over_capacity: true });
      expect(forced.status).toBe(201);
      expect(forced.body.booking.bookings_that_day).toBe(2);
      expect((await owner.get('/api/bookings/capacity?date=2027-04-04')).body).toMatchObject({ count: 2, max: 1, full: true });
    } finally {
      await pool.query(`UPDATE business_settings SET max_bookings_per_day = NULL WHERE tenant_id = $1`, [tenantId]);
    }
  });

  test('moving a card changes the status, records history and audit; bad moves are refused', async () => {
    const { quoteId } = await whatsappQuote();
    const { body: { booking } } = await owner.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'Ameerpet' });
    expect((await owner.post(`/api/bookings/${booking.id}/status`, { status: 'completed' })).status).toBe(400);
    expect((await owner.post(`/api/bookings/${booking.id}/status`, { status: 'cancelled' })).status).toBe(400);   // needs a reason
    const r = await owner.post(`/api/bookings/${booking.id}/status`, { status: 'cancelled', reason: 'Customer postponed' });
    expect(r.body.booking).toMatchObject({ status: 'cancelled', cancelled_reason: 'Customer postponed' });
    const hist = (await pool.query(`SELECT to_status, actor_type, actor_user_id FROM booking_status_history WHERE booking_id = $1 ORDER BY created_at`, [booking.id])).rows;
    expect(hist.at(-1)).toEqual({ to_status: 'cancelled', actor_type: 'agent', actor_user_id: owner.user.id });
    const a = await one(`SELECT action, after FROM audit_log WHERE entity_id = $1 AND action = 'booking.status'`, [booking.id]);
    expect(a.after).toMatchObject({ status: 'cancelled' });
    const back = await owner.post(`/api/bookings/${booking.id}/status`, { status: 'advance_pending' });
    expect(back.body.booking.status).toBe('advance_pending');
  });

  test('the board shows open leads and bookings by column', async () => {
    const { quoteId } = await whatsappQuote();
    await whatsappQuote('basic');   // stays a quoted lead
    const { body: { booking } } = await owner.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'Bachupally' });
    const r = await agent.get('/api/bookings/board');
    expect(r.status).toBe(200);
    expect(r.body.columns.advance_pending.map((b) => b.id)).toContain(booking.id);
    expect(r.body.columns.quoted.length).toBeGreaterThan(0);
    expect(r.body.columns.quoted[0]).toHaveProperty('latest_quote_id');
    // sandbox chats never show up
    expect(JSON.stringify(r.body)).not.toMatch(/Test customer/);
  });
});

describe('payments and confirmation', () => {
  test('marking the advance as received confirms the booking and sends the confirmation template', async () => {
    const { rows: [acc] } = await pool.query(`SELECT id FROM whatsapp_accounts WHERE tenant_id = $1 AND is_primary`, [tenantId]);
    await pool.query(
      `INSERT INTO templates (tenant_id, whatsapp_account_id, name, language, category, status, purpose, components, variable_map)
       VALUES ($1,$2,'booking_confirmed','en','UTILITY','approved','booking_confirmation',
               '[{"type":"BODY","text":"Hi {{1}}, booking {{2}} on {{3}} is confirmed. Balance {{4}}."}]',
               '{"1":"contact.name","2":"booking.code","3":"booking.event_date","4":"booking.balance"}')
       ON CONFLICT DO NOTHING`, [tenantId, acc.id]);
    const { quoteId, conversationId } = await whatsappQuote();
    const { body: { booking } } = await owner.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'Nizampet' });

    const part = await owner.post(`/api/bookings/${booking.id}/payments`, { amount: 1000, method: 'upi', reference: `UTR${Date.now()}` });
    expect(part.status).toBe(201);
    expect(part.body.booking).toMatchObject({ status: 'advance_pending', advance_status: 'partial', advance_paid_amount: '1000.00' });
    expect(part.body.confirmation).toBeNull();

    const full = await owner.post(`/api/bookings/${booking.id}/payments`, { amount: 2000, method: 'cash' });
    expect(full.body.booking).toMatchObject({ status: 'confirmed', advance_status: 'paid', advance_paid_amount: '3000.00', balance_amount: '7000.00' });
    expect(full.body.confirmation).toMatchObject({ sent: true, via: 'template', template: 'booking_confirmed' });
    expect(full.body.booking.confirmed_at).not.toBeNull();

    await drain();
    const sent = graph.requests.find((r) => r.body?.type === 'template');
    expect(sent.body.template).toMatchObject({ name: 'booking_confirmed', language: { code: 'en' } });
    const params = sent.body.template.components[0].parameters.map((p) => p.text);
    expect(params).toEqual([expect.stringMatching(/Booker/), booking.booking_code, '20 Feb 2027', '₹7,000']);
    const msg = await one(`SELECT sender_type, message_type, status FROM messages WHERE conversation_id = $1 AND message_type = 'template'`, [conversationId]);
    expect(msg).toMatchObject({ sender_type: 'system', status: 'sent' });
  });

  test('without an approved template, a text confirmation goes out inside the 24h window', async () => {
    await pool.query(`UPDATE templates SET status = 'paused' WHERE purpose = 'booking_confirmation'`);
    const { quoteId, conversationId } = await whatsappQuote();
    const { body: { booking } } = await owner.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'Lingampally' });
    const r = await owner.post(`/api/bookings/${booking.id}/payments`, { amount: 3000, method: 'upi', reference: `UTRT${Date.now()}` });
    expect(r.body.confirmation).toMatchObject({ sent: true, via: 'text' });
    const msg = await one(`SELECT body FROM messages WHERE conversation_id = $1 AND sender_type = 'system' ORDER BY created_at DESC LIMIT 1`, [conversationId]);
    expect(msg.body).toContain(booking.booking_code);
    expect(msg.body).toContain('Balance: ₹7,000');
  });

  test('payment validation: no overpaying, no duplicate references, refunds tracked, agents need permission', async () => {
    const { quoteId } = await whatsappQuote();
    const { body: { booking } } = await owner.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'Chandanagar' });
    expect((await owner.post(`/api/bookings/${booking.id}/payments`, { amount: 20000, method: 'upi' })).status).toBe(400);
    const ref = `UTRD${Date.now()}`;
    expect((await owner.post(`/api/bookings/${booking.id}/payments`, { amount: 500, method: 'upi', reference: ref })).status).toBe(201);
    expect((await owner.post(`/api/bookings/${booking.id}/payments`, { amount: 500, method: 'upi', reference: ref })).status).toBe(409);
    const refund = await owner.post(`/api/bookings/${booking.id}/payments`, { kind: 'refund', amount: 500, method: 'upi' });
    expect(refund.body.booking).toMatchObject({ advance_paid_amount: '0.00', advance_status: 'refunded' });
    expect((await agent.post(`/api/bookings/${booking.id}/payments`, { amount: 100, method: 'cash' })).status).toBe(403);
  });

  test('details include payments, history and the quote breakdown', async () => {
    const { quoteId } = await whatsappQuote();
    const { body: { booking } } = await owner.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'Hafeezpet' });
    await owner.post(`/api/bookings/${booking.id}/payments`, { amount: 3000, method: 'cash' });
    const r = await agent.get(`/api/bookings/${booking.id}`);
    expect(r.body.booking.payments).toHaveLength(1);
    expect(r.body.booking.history.map((h) => h.to_status)).toEqual(['advance_pending', 'confirmed']);
    expect(r.body.booking.line_items[0]).toMatchObject({ kind: 'design' });
    const upd = await owner.patch(`/api/bookings/${booking.id}`, { event_time: '18:30', internal_notes: 'Gate code 4512' });
    expect(upd.body.booking).toMatchObject({ event_time: '18:30:00', internal_notes: 'Gate code 4512' });
  });
});

describe('leads', () => {
  test('list with counts, mark lost with a reason, booked leads are read-only', async () => {
    const open = await whatsappQuote('basic');
    const { id: leadId } = await one(`SELECT id FROM leads WHERE conversation_id = $1`, [open.conversationId]);
    const list = await agent.get('/api/leads?status=open');
    expect(list.body.leads.map((l) => l.id)).toContain(leadId);
    expect(list.body.counts.open).toBeGreaterThan(0);

    expect((await agent.patch(`/api/leads/${leadId}`, { status: 'lost' })).status).toBe(400);
    const lost = await agent.patch(`/api/leads/${leadId}`, { status: 'lost', lost_reason: 'Went with another vendor' });
    expect(lost.body.lead).toMatchObject({ status: 'lost', lost_reason: 'Went with another vendor' });

    const booked = await whatsappQuote();
    await owner.post('/api/bookings', { quote_id: booked.quoteId, event_date: FAR_DATE, venue_address: 'Miyapur' });
    const { id: wonId } = await one(`SELECT id FROM leads WHERE conversation_id = $1`, [booked.conversationId]);
    expect((await agent.patch(`/api/leads/${wonId}`, { guest_count: 10 })).status).toBe(400);

    const detail = await agent.get(`/api/leads/${wonId}`);
    expect(detail.body.bookings).toHaveLength(1);
    expect(detail.body.quotes[0]).toMatchObject({ status: 'accepted' });
  });

  test('the inbox details include the lead and bookings', async () => {
    const { conversationId, quoteId } = await whatsappQuote();
    await owner.post('/api/bookings', { quote_id: quoteId, event_date: FAR_DATE, venue_address: 'KPHB' });
    const r = await agent.get(`/api/conversations/${conversationId}`);
    expect(r.body.conversation.lead).toMatchObject({ status: 'won', venue_address: 'KPHB', event_date: FAR_DATE });
    expect(r.body.conversation.bookings[0]).toMatchObject({ status: 'advance_pending' });
  });
});
