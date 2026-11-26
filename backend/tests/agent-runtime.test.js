// AI agent runtime: scripted conversations against a mock LLM (M6 acceptance a–g),
// plus the worker path (webhook -> debounced AI job -> delayed send) and takeover.
const { pool, signedIn } = require('./helpers');
const { startMockLlm, say, call, toolResult, lastUser, inr } = require('./mock-llm');
const { startMockGraph } = require('./mock-graph');
const { postWebhook, inboundText, ensureAccount } = require('./wa-helpers');
const { image } = require('./gallery-helpers');
const { runImport } = require('../src/gallery/importer');
const { createWorker } = require('../src/queue/worker-loop');
const handlers = require('../src/queue/handlers');
const pricing = require('../src/pricing/pricing.service');
const { extractAmounts } = require('../src/agent/guard');
const bus = require('../src/realtime/bus');

let llm;
let graph;
let owner;
let tenantId;
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const BASE = { lat: 17.4967, lng: 78.3577 };
const KONDAPUR = { lat: 17.4615, lng: 78.3647 };
const FAR = { lat: 17.2403, lng: 78.4294 };            // airport side: > 25 km

async function chat(text) {
  const res = await owner.post('/api/agent/sandbox/messages', { text });
  if (res.status !== 200) throw new Error(`sandbox: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const botTexts = (state) => state.messages.filter((m) => m.direction === 'outbound' && !m.is_internal_note && m.message_type === 'text').map((m) => m.body);

beforeAll(async () => {
  llm = await startMockLlm(Number(process.env.LLM_MOCK_PORT));
  graph = await startMockGraph(Number(process.env.GRAPH_MOCK_PORT));
  owner = await signedIn('owner');
  ({ id: tenantId } = await one(`SELECT id FROM tenants WHERE slug = 'balloonsbuzz'`));
  await pool.query(
    `UPDATE ai_agent_config SET is_enabled = true, provider = 'deepseek', base_url = $1, model = 'mock-model', fallback_model = NULL,
            response_delay_min_ms = 0, response_delay_max_ms = 0, max_message_chars = 300, max_messages_per_turn = 3`,
    [`http://127.0.0.1:${process.env.LLM_MOCK_PORT}`]);
  await pool.query(`UPDATE business_settings SET base_lat = $1, base_lng = $2, road_factor = 1.3 WHERE tenant_id = $3`, [BASE.lat, BASE.lng, tenantId]);
  // other suites change the global discount rule: pin the one these scenarios assume
  await pool.query(`UPDATE negotiation_rules SET max_discount_pct = 10, max_discount_amount = NULL, min_final_price = NULL,
                      concession_step_pct = 5, max_rounds = 2, applies_to_addons = false, applies_to_distance_charge = false
                     WHERE tenant_id = $1 AND scope = 'global'`, [tenantId]);
  const { rows: [zorbo] } = await pool.query(`INSERT INTO themes (tenant_id, key, name) VALUES ($1, 'zorbo', 'Zorbo') RETURNING id`, [tenantId]);
  await pool.query(`INSERT INTO theme_aliases (tenant_id, theme_id, alias) VALUES ($1, $2, 'zorbo')`, [tenantId, zorbo.id]);

  // A small gallery with its own theme (other suites import dinosaur photos into the same test DB)
  const files = [
    ['2 frames decor/zorbo/Zorbo Theme (10k-12k).jpeg', 'd1'],
    ['2 frames decor/zorbo/Zorbo Party (11k-12k).jpeg', 'd2'],
    ['2 frames decor/zorbo/Zorbo Jungle (10k-11k).jpeg', 'd3'],
    ['single frame/zorbo/Zorbo Single (10k-12k).jpg', 'd4'],
    ['2 frames decor/zorbo/WhatsApp Image 2026-09-01 at 1.00.00 PM.jpeg', 'd5'],
  ];
  const entries = await Promise.all(files.map(async ([p, seed]) => ({ path: p, read: async () => image(`agent-${seed}`) })));
  await runImport({ tenantId, source: { name: 'upload', list: async () => entries } });
});

afterAll(async () => {
  // All suites share one test database: leave it as other suites expect it.
  await pool.query(`UPDATE ai_agent_config SET is_enabled = false, base_url = NULL, fallback_model = NULL`);
  await pool.query(`UPDATE business_settings SET base_lat = NULL, base_lng = NULL WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM gallery_assets WHERE id IN (SELECT asset_id FROM gallery_items WHERE source = 'upload')`);
  await pool.query(`DELETE FROM gallery_sync_runs WHERE source = 'upload'`);
  await pool.query(`DELETE FROM themes WHERE tenant_id = $1 AND key = 'zorbo'`, [tenantId]);
  await bus.stop(); await llm.close(); await graph.close(); await pool.end();
});

beforeEach(async () => {
  llm.reset();
  await owner.post('/api/agent/sandbox/reset', {});
});

describe('(a) qualifying the details', () => {
  test('saves date, occasion, theme, venue and budget, and the prompt + context reach the model', async () => {
    llm.script(
      call('update_lead', { occasion: 'birthday', theme: 'spidey', event_date: '2026-12-20', venue_address: 'Kondapur', budget_min: 8000, budget_max: 10000 }),
      say('Lovely, a Spiderman 5th birthday! 🎉 I’ll share some designs now.'),
    );
    const s = await chat('Hi! Son’s 5th bday on 20 Dec, Spiderman theme, at Kondapur, ~40 guests, budget 8-10k');
    expect(s.result.outcome).toBe('replied');
    expect(s.lead).toMatchObject({ occasion_name: 'Birthday', theme_name: 'Spiderman', guest_count: null, venue_address: 'Kondapur', missing: [] });
    expect(s.lead.qualified_at).not.toBeNull();
    expect([Number(s.lead.budget_min), Number(s.lead.budget_max)]).toEqual([8000, 10000]);

    const first = llm.requests[0].body;
    expect(first.messages[0].content).toMatch(/BalloonsBuzz WhatsApp assistant/);          // Phase 4 prompt file
    expect(first.messages[1].content).toMatch(/Still missing: event_date, occasion, theme, venue, budget\. Ask for the event date first\./);
    expect(first.messages[1].content).not.toMatch(/guest/);
    expect(first.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(['get_pricing', 'send_photos', 'update_lead', 'handover_to_human', 'mark_lead_lost']));
    expect(first.tools.find((t) => t.function.name === 'update_lead').function.parameters.properties).not.toHaveProperty('guest_count');
    expect(llm.requests[0].auth).toBe('Bearer sk-test-env-key-0000');
    // the second turn sees the saved details
    llm.script(say('Shall I send a few Spiderman designs?'));
    await chat('ok');
    expect(llm.requests[2].body.messages[1].content).toMatch(/All details collected/);
  });

  test('photos and prices still go out without a date, with a reminder to ask for it', async () => {
    llm.script(call('send_photos', { theme: 'zorbo', count: 1 }), say('Here is one! Which date is the party? 📅'));
    await chat('zorbo designs please');
    expect(toolResult(llm.requests[1].body, 'send_photos').ask_date).toMatch(/ask for it/);
    llm.script(call('update_lead', { event_date: '2026-12-20' }), call('send_photos', { theme: 'zorbo', count: 1 }), say('Another one 🎈'));
    await chat('20 Dec');
    expect(toolResult(llm.requests[4].body, 'send_photos').sent).toHaveLength(1);
    expect(toolResult(llm.requests[4].body, 'send_photos')).not.toHaveProperty('ask_date');
  });
});

describe('closing lost enquiries', () => {
  const lostLead = () => one(
    `SELECT l.status, l.lost_reason FROM leads l JOIN conversations cv ON cv.id = l.conversation_id
      WHERE cv.is_sandbox AND l.deleted_at IS NULL ORDER BY l.updated_at DESC LIMIT 1`);
  const todayIST = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  test('"booked somewhere else" marks the lead lost and cancels pending follow-ups', async () => {
    llm.script(call('update_lead', { occasion: 'birthday' }), call('schedule_followup', { send_at: new Date(Date.now() + 86_400_000).toISOString(), message: 'Hi again 🎈' }), say('Sure, take your time!'));
    await chat('birthday, will check and tell');
    // a follow-up the customer's next message would not cancel (like an automation's quote reminder)
    await pool.query(`UPDATE followups f SET cancel_on_reply = false FROM conversations cv WHERE cv.id = f.conversation_id AND cv.is_sandbox`);
    llm.script(call('mark_lead_lost', { reason: 'booked_elsewhere', details: 'booked with a friend' }), say('No problem, thank you! Message us any time 🎈'));
    const s = await chat('we already booked with someone else');
    expect(s.result.outcome).toBe('replied');
    expect(await lostLead()).toEqual({ status: 'lost', lost_reason: 'Booked elsewhere: booked with a friend' });
    expect(s.lead).toEqual(expect.objectContaining({ missing: expect.arrayContaining(['event_date']) }));   // no open lead now
    const { rows } = await pool.query(
      `SELECT f.status, f.cancel_reason FROM followups f JOIN conversations cv ON cv.id = f.conversation_id WHERE cv.is_sandbox`);
    expect(rows).toEqual([{ status: 'cancelled', cancel_reason: 'lead lost' }]);
  });

  test('"not interested" before anything was saved still counts as a lost lead', async () => {
    llm.script(call('mark_lead_lost', { reason: 'not_interested' }), say('Okay, thank you! 😊'));
    await chat('not interested');
    expect(await lostLead()).toEqual({ status: 'lost', lost_reason: 'Not interested' });
  });

  test('an unknown reason is refused', async () => {
    llm.script(call('mark_lead_lost', { reason: 'too_expensive' }), say('ok'));
    await chat('too costly');
    expect(toolResult(llm.requests[1].body, 'mark_lead_lost').error).toMatch(/reason/);
  });

  test('a same-day event closes the lead; a past date is sent back to be checked', async () => {
    llm.script(call('update_lead', { occasion: 'birthday', event_date: todayIST() }), say('Sorry, we need the order a day before 🙏'));
    await chat('birthday today evening');
    expect(toolResult(llm.requests[1].body, 'update_lead').lead_closed).toMatch(/today/);
    expect(await lostLead()).toEqual({ status: 'lost', lost_reason: 'Event is today (same day)' });

    await owner.post('/api/agent/sandbox/reset', {});
    llm.reset();
    llm.script(call('update_lead', { occasion: 'birthday', event_date: '2020-01-05' }), say('Which year? 📅'));
    const s = await chat('5th Jan');
    expect(toolResult(llm.requests[1].body, 'update_lead').error).toMatch(/in the past/);
    expect(s.lead).toMatchObject({ status: 'qualifying', event_date: null, occasion_name: 'Birthday' });
  });

  test('open leads whose event day has come are closed by the clock; booked ones are not', async () => {
    const { closeDueLeads } = require('../src/agent/leads');
    llm.script(call('update_lead', { event_date: '2026-12-20' }), say('Noted!'));
    await chat('20 Dec');
    expect(await closeDueLeads({ tenantId, today: '2026-12-19' })).toBe(0);
    expect(await closeDueLeads({ tenantId, today: '2026-12-20' })).toBeGreaterThanOrEqual(1);
    expect(await lostLead()).toEqual({ status: 'lost', lost_reason: 'Event day reached without booking' });
    const won = await one(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND status = 'won' AND lost_reason IS NOT NULL`, [tenantId]);
    expect(won.n).toBe(0);
  });
});

describe('(b) photos', () => {
  test('sends matching photos with captions and never repeats one', async () => {
    llm.script(call('send_photos', { theme: 'zorbo', package_key: 'two_frames', budget_min: 10000, budget_max: 12000, count: 2 }), say('Which one do you like? 😊'));
    const s1 = await chat('Show me zorbo 2 frame designs around 10-12k');
    const photos1 = s1.messages.filter((m) => m.message_type === 'image');
    expect(photos1).toHaveLength(2);
    for (const p of photos1) expect(p.body).toMatch(/₹1[01],000 – ₹1[12],000 \(estimate\)/);

    llm.script(call('send_photos', { theme: 'zorbo', package_key: 'two_frames', budget_min: 10000, budget_max: 12000, count: 2 }), say('Here are more!'));
    const s2 = await chat('more please');
    const photos = s2.messages.filter((m) => m.message_type === 'image');
    expect(photos).toHaveLength(3);                                   // only one zorbo 2-frame photo was left
    expect(new Set(photos.map((p) => p.gallery_item_id)).size).toBe(3);
    expect(photos.some((p) => /WhatsApp Image/.test(p.body || ''))).toBe(false);   // generic names are never sent
    // the model is told what was already sent
    expect(llm.requests[2].body.messages[1].content).toMatch(/Photos already sent[\s\S]*photo_id/);
  });

  test('photo prices from captions may be repeated by the bot', async () => {
    llm.script(call('send_photos', { theme: 'zorbo', package_key: 'two_frames', count: 1 }), (b) => {
      const [lo, hi] = toolResult(b, 'send_photos').sent[0].price_range;
      return say(`This one is ${inr(lo)} – ${inr(hi)} approx 😊`);
    });
    const s = await chat('zorbo designs?');
    expect(s.result.outcome).toBe('replied');
    expect(llm.requests).toHaveLength(2);
  });
});

describe('(c) negotiation below the floor', () => {
  test('counter, then the lowest price, then a person takes over; the bot never says less than the floor', async () => {
    llm.script(
      call('get_pricing', { package_key: 'two_frames' }),
      (b) => say(`The 2-frame setup is ${inr(toolResult(b, 'get_pricing').total_price)} 🎈`),
    );
    const s1 = await chat('How much is 2 frames decor?');
    const q = s1.quotes[0];
    expect(q).toMatchObject({ status: 'issued', final_price: '20000.00', floor_price: '18000.00' });   // ₹6.5k–20k, global 10%

    const counter = (b) => {
      const r = toolResult(b, 'check_negotiation_limit');
      return say(r.decision === 'escalate' ? 'Let me check with the team 🙏' : `I can do ${inr(r.price)} for you 😊`);
    };
    llm.script(call('check_negotiation_limit', { quote_id: q.id, requested_price: 12000 }), counter);
    const s2 = await chat('12000 final?');
    expect(s2.quotes[0]).toMatchObject({ status: 'negotiating', final_price: '19000.00', rounds_used: 1 });

    llm.script(call('check_negotiation_limit', { quote_id: q.id, requested_price: 12000 }), counter);
    const s3 = await chat('Still too much, 12000');
    expect(s3.quotes[0]).toMatchObject({ final_price: '18000.00', rounds_used: 2 });

    llm.script(call('check_negotiation_limit', { quote_id: q.id, requested_price: 12000 }), counter);
    const s4 = await chat('12000 or I go elsewhere');
    expect(s4.result.outcome).toBe('handover');
    expect(s4.conversation).toMatchObject({ handling_mode: 'human', needs_human: true });
    expect(s4.quotes[0].status).toBe('escalated');
    const ev = await one(`SELECT trigger, metadata FROM handover_events WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [s4.conversation.id]);
    expect(ev).toMatchObject({ trigger: 'discount_limit', metadata: expect.objectContaining({ floor_price: 18000, requested_price: 12000 }) });
    expect(s4.messages.some((m) => m.is_internal_note && /Handed over/.test(m.body))).toBe(true);

    const amounts = botTexts(s4).flatMap(extractAmounts);
    expect(amounts).toEqual(expect.arrayContaining([20000, 19000, 18000]));
    expect(amounts.every((v) => v >= 18000)).toBe(true);
    const events = await pool.query(`SELECT event_type FROM quote_events WHERE quote_id = $1 ORDER BY created_at, event_type`, [q.id]);
    expect(events.rows.map((e) => e.event_type)).toEqual(expect.arrayContaining(['issued', 'counter_request', 'counter_offer', 'escalated']));
  });

  test('an offer within the limit is accepted', async () => {
    llm.script(call('get_pricing', { package_key: 'two_frames' }), say('It is ₹20,000 😊'));
    await chat('price for 2 frames?');
    llm.script(call('check_negotiation_limit', { requested_price: 19500 }), (b) => say(`Done, ${inr(toolResult(b, 'check_negotiation_limit').price)} 🎉`));
    const s = await chat('can you do 19500?');
    expect(s.quotes[0]).toMatchObject({ status: 'accepted', final_price: '19500.00' });
    expect(botTexts(s).at(-1)).toBe('Done, ₹19,500 🎉');
  });
});

describe('(d) the outbound guard', () => {
  test('an invented price is blocked, the model gets one retry, then a person takes over', async () => {
    llm.script(say('Basic decor is ₹4,200 only!'), say('Okay, ₹4,200 it is.'));
    const s = await chat('how much for basic decor?');
    expect(s.result).toMatchObject({ outcome: 'blocked', blocked_reason: 'unknown_price:4200' });
    expect(botTexts(s).join(' ')).not.toMatch(/4,200/);
    expect(s.conversation.handling_mode).toBe('human');
    expect(llm.requests[1].body.messages.at(-1).content).toMatch(/NOT sent: it mentions ₹4,200/);
    expect(s.runs[0]).toMatchObject({ outcome: 'blocked', blocked_reason: 'unknown_price:4200' });
  });

  test('after the correction the model uses the tool and the reply goes out', async () => {
    llm.script(
      say('Basic decor is ₹4,200 only!'),
      call('get_pricing', { package_key: 'basic' }),
      (b) => say(`Basic decor is ${inr(toolResult(b, 'get_pricing').total_price)} 😊`),
    );
    const s = await chat('how much for basic decor?');
    expect(s.result.outcome).toBe('replied');
    expect(botTexts(s)).toEqual(['Basic decor is ₹5,000 😊']);
  });

  test('a customer’s own number below the floor cannot be echoed as agreed', async () => {
    llm.script(call('get_pricing', { package_key: 'two_frames' }), say('It is ₹20,000 😊'));
    await chat('2 frames price?');
    llm.script(say('Okay ₹9,000 works!'), say('Fine, ₹9,000.'));
    const s = await chat('9000 ok?');
    expect(s.result.outcome).toBe('blocked');
  });
});

describe('(e) location pin and travel charge', () => {
  test('a pin gets the slab charge from the Miyapur base', async () => {
    const expected = await pricing.distanceQuote({ tenantId, location: KONDAPUR });
    expect(expected.serviceable).toBe(true);
    llm.script(
      (b) => {
        const m = /latitude ([\d.]+), longitude ([\d.]+)/.exec(lastUser(b));
        return call('calculate_distance_charge', { latitude: Number(m[1]), longitude: Number(m[2]) });
      },
      (b) => {
        const r = toolResult(b, 'calculate_distance_charge');
        return say(r.travel_charge ? `Travel to your venue is ${inr(r.travel_charge)} (${r.km} km)` : `No travel charge for ${r.km} km 😊`);
      },
    );
    const res = await owner.post('/api/agent/sandbox/messages', { location: { ...KONDAPUR, address: 'Kondapur, Hyderabad' } });
    expect(res.status).toBe(200);
    expect(res.body.lead).toMatchObject({ distance_method: 'haversine' });
    expect(Number(res.body.lead.distance_km)).toBeCloseTo(expected.km, 1);
    expect(Number(res.body.lead.distance_charge)).toBe(expected.charge);
    const last = botTexts(res.body).at(-1);
    expect(last).toContain(expected.charge ? inr(expected.charge) : 'No travel charge');
  });

  test('outside the service area hands over', async () => {
    llm.script(call('calculate_distance_charge', { latitude: FAR.lat, longitude: FAR.lng }), say('A team member will check 🙏'));
    const res = await owner.post('/api/agent/sandbox/messages', { location: FAR });
    expect(res.body.result.outcome).toBe('handover');
    const ev = await one(`SELECT trigger FROM handover_events WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [res.body.conversation.id]);
    expect(ev.trigger).toBe('out_of_area');
  });

  test('travel is included in the next quote', async () => {
    llm.script(call('calculate_distance_charge', { latitude: KONDAPUR.lat, longitude: KONDAPUR.lng }), say('Got it 📍'));
    await owner.post('/api/agent/sandbox/messages', { location: KONDAPUR });
    const expected = await pricing.distanceQuote({ tenantId, location: KONDAPUR });
    llm.script(call('get_pricing', { package_key: 'semi_arch' }), (b) => say(`Total ${inr(toolResult(b, 'get_pricing').total_price)}`));
    const s = await chat('semi arch total?');
    expect(Number(s.quotes[0].distance_charge)).toBe(expected.charge);
    expect(botTexts(s).at(-1)).toBe(`Total ${inr(10000 + expected.charge)}`);
  });
});

describe('(f) asking for a person', () => {
  test('"talk to a person" hands over before the model is called', async () => {
    const s = await chat('Can I talk to a person please');
    expect(s.result).toMatchObject({ outcome: 'handover', keyword: true });
    expect(llm.requests).toHaveLength(0);
    expect(s.conversation.handling_mode).toBe('human');
    expect(botTexts(s).at(-1)).toMatch(/Connecting you with our team/);
  });

  test('the model can hand over too (customer wants the owner)', async () => {
    llm.script(call('handover_to_human', { reason: 'Customer wants to speak to the owner', summary: 'Spiderman birthday, 20 Dec' }), say('should not be sent'));
    const s = await chat('I want the owner’s number');
    expect(s.result.outcome).toBe('handover');
    expect(botTexts(s).join(' ')).not.toMatch(/should not be sent/);
    const ev = await one(`SELECT trigger FROM handover_events WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [s.conversation.id]);
    expect(ev.trigger).toBe('customer_request');
    expect(s.messages.some((m) => m.is_internal_note && /Spiderman birthday, 20 Dec/.test(m.body))).toBe(true);
  });

  test('once handed over the bot stays quiet until resumed', async () => {
    await chat('talk to a person');
    const s = await chat('hello?');
    expect(s.result.outcome).toBe('skipped_human');
    expect(llm.requests).toHaveLength(0);
    await owner.post('/api/agent/sandbox/resume', {});
    llm.script(say('Hi again! 😊'));
    const s2 = await chat('hello?');
    expect(s2.result.outcome).toBe('replied');
  });
});

describe('(g) short messages', () => {
  test('a long reply is split into WhatsApp-sized messages of at most 300 characters', async () => {
    const long = `${'We decorate birthdays, baby showers and anniversaries all over Hyderabad with fresh balloons. '.repeat(3)}\n\n${'Tell me the date and the venue and I will check availability for you right away. '.repeat(3)}`;
    llm.script(say(long));
    const s = await chat('tell me about you');
    const texts = botTexts(s);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.length).toBeLessThanOrEqual(3);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(300);
    expect(texts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });

  test('a reply that needs too many messages is sent back to be shortened', async () => {
    llm.script(say('Balloons are great. '.repeat(80)), say('We do it all! 🎈 What is the occasion?'));
    const s = await chat('what do you do');
    expect(botTexts(s)).toEqual(['We do it all! 🎈 What is the occasion?']);
    expect(llm.requests[1].body.messages.at(-1).content).toMatch(/too long/);
  });
});

describe('found in the live eval', () => {
  test('an empty model reply gets one retry, then a person takes over', async () => {
    llm.script(say(''), say('Hi! 🎈 What are we celebrating?'));
    expect(botTexts(await chat('hi'))).toEqual(['Hi! 🎈 What are we celebrating?']);
    llm.script(say(''), say(''));
    const s = await chat('hello?');
    expect(s.result.outcome).toBe('handover');
    const ev = await one(`SELECT trigger FROM handover_events WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [s.conversation.id]);
    expect(ev.trigger).toBe('bot_stuck');
  });

  test('no text after the location button is fine (no retry, no handover)', async () => {
    llm.script(call('request_location', {}), say(''));
    const s = await chat('semi arch, what is the total?');
    expect(s.result.outcome).toBe('replied');
    expect(llm.requests).toHaveLength(2);
    expect(s.messages.filter((m) => m.direction === 'outbound' && !m.is_internal_note).map((m) => m.payload?.send_type)).toEqual(['location_request']);
  });

  test('event dates are not shifted by the time zone', async () => {
    llm.script(call('update_lead', { event_date: '2026-12-14' }), say('Noted 14 Dec 📅'));
    const s = await chat('on 14th December');
    expect(s.lead.event_date).toBe('2026-12-14');
    llm.script(say('ok'));
    await chat('ok');
    expect(llm.requests[2].body.messages[1].content).toMatch(/- date: 2026-12-14/);
  });

  test('a design category given as the theme is saved as the category and used for photos', async () => {
    llm.script(call('update_lead', { theme: 'two frames decoration' }), call('send_photos', { theme: '2 frames' }), say('Here you go!'));
    const s = await chat('2 frames decoration please');
    expect(s.lead).toMatchObject({ theme_id: null, theme_text: null });
    expect(s.lead.missing).not.toContain('theme');
    const photos = s.messages.filter((m) => m.message_type === 'image');
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((p) => /2 Frames Decor/.test(p.body))).toBe(true);
  });

  test('photos already sent are listed in the order the customer saw them', async () => {
    llm.script(call('send_photos', { theme: 'zorbo', count: 3 }), say('Which one?'));
    const s = await chat('zorbo designs');
    const sentOrder = s.messages.filter((m) => m.message_type === 'image').map((m) => m.gallery_item_id);
    llm.script(say('Great choice!'));
    await chat('the first one');
    const ctxText = llm.requests[2].body.messages[1].content;
    const listed = [...ctxText.matchAll(/photo_id ([0-9a-f-]{36})/g)].map((m) => m[1]);
    expect(listed).toEqual(sentOrder);
  });
});

describe('robustness', () => {
  test('bad tool arguments are reported to the model, not thrown', async () => {
    llm.script(call('update_lead', { event_date: 'next friday' }), say('Which date exactly? 📅'));
    const s = await chat('next friday');
    expect(s.result.outcome).toBe('replied');
    expect(toolResult(llm.requests[1].body, 'update_lead').error).toMatch(/event_date: Use YYYY-MM-DD/);
    expect(s.runs[0].tool_calls[0]).toMatchObject({ tool: 'update_lead', success: false });
  });

  test('the fallback model is used when the main one fails', async () => {
    await pool.query(`UPDATE ai_agent_config SET fallback_model = 'mock-fallback'`);
    llm.script({ fail: 400, message: 'bad model' }, say('Hello from the fallback 🎈'));
    const s = await chat('hi');
    expect(botTexts(s)).toEqual(['Hello from the fallback 🎈']);
    expect(llm.requests[1].body.model).toBe('mock-fallback');
    expect(s.runs[0]).toMatchObject({ model: 'mock-fallback' });
    await pool.query(`UPDATE ai_agent_config SET fallback_model = NULL`);
  });

  test('token usage and cost are recorded per run', async () => {
    llm.script(say('Hi! 🎈'));
    const s = await chat('hi');
    expect(s.runs[0]).toMatchObject({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, iterations: 1 });
    expect(Number(s.runs[0].cost_inr)).toBeGreaterThan(0);
  });

  test('a model error is shown in the test console instead of failing the request', async () => {
    llm.script({ fail: 401, message: 'invalid api key' });
    const s = await chat('hi');
    expect(s.result).toMatchObject({ outcome: 'error', error: expect.stringMatching(/invalid api key/) });
    expect(s.runs[0]).toMatchObject({ outcome: 'error' });
  });

  test('switched off: the bot does not answer', async () => {
    await pool.query(`UPDATE ai_agent_config SET is_enabled = false`);
    const s = await chat('hi');
    expect(s.result.outcome).toBe('skipped_disabled');
    await pool.query(`UPDATE ai_agent_config SET is_enabled = true`);
  });
});

describe('real WhatsApp path (worker)', () => {
  let worker;
  const drain = () => worker.drain({ timeoutMs: 30_000 });
  beforeAll(async () => {
    await ensureAccount(owner);
    worker = createWorker({ handlers, concurrency: 4, pollMs: 50 });
  });

  test('an inbound message gets an AI reply sent through Meta, and the sandbox stays out of the inbox', async () => {
    llm.script(say('Hi Ravi! 🎈 Which occasion are you planning for?'));
    const phone = `9198700${String(Date.now()).slice(-5)}`;
    await postWebhook(inboundText(`wamid.AI${Date.now()}`, 'Hi, need decoration', phone, 'Ravi'));
    await drain();
    const conv = await one(`SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.phone = $1`, [phone]);
    const msg = await one(`SELECT status, sender_type, body, ai_run_id FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`, [conv.id]);
    expect(msg).toMatchObject({ status: 'sent', sender_type: 'bot', body: 'Hi Ravi! 🎈 Which occasion are you planning for?' });
    expect(msg.ai_run_id).not.toBeNull();
    expect(graph.requests.some((r) => r.body?.text?.body === msg.body)).toBe(true);

    const list = await owner.get('/api/conversations');
    expect(list.body.conversations.some((c) => /Test customer/.test(c.contact_name || ''))).toBe(false);
  });

  test('a bot message waiting for its typing delay is dropped when a person takes over', async () => {
    await pool.query(`UPDATE ai_agent_config SET response_delay_min_ms = 60000, response_delay_max_ms = 60000`);
    llm.script(say('Sure, let me show you designs!'));
    const phone = `9198701${String(Date.now()).slice(-5)}`;
    await postWebhook(inboundText(`wamid.AI2${Date.now()}`, 'Need ring frame decor', phone, 'Anu'));
    await drain();
    const conv = await one(`SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.phone = $1`, [phone]);
    const queued = await one(`SELECT id, status FROM messages WHERE conversation_id = $1 AND sender_type = 'bot'`, [conv.id]);
    expect(queued.status).toBe('queued');                       // waiting for the delay

    await owner.post(`/api/conversations/${conv.id}/takeover`, {});
    await pool.query(`UPDATE jobs SET run_at = now() WHERE name = 'send_message' AND payload->>'message_id' = $1`, [queued.id]);
    await drain();
    expect((await one(`SELECT status FROM messages WHERE id = $1`, [queued.id])).status).toBe('cancelled');
    await pool.query(`UPDATE ai_agent_config SET response_delay_min_ms = 0, response_delay_max_ms = 0`);
  });

  test('a model outage hands the chat to a person instead of leaving the customer waiting', async () => {
    llm.script({ fail: 500 }, { fail: 500 }, { fail: 500 }, { fail: 500 });
    const phone = `9198702${String(Date.now()).slice(-5)}`;
    await postWebhook(inboundText(`wamid.AI3${Date.now()}`, 'hello', phone, 'Meena'));
    await drain();
    // retried once by the queue, then handed over
    await pool.query(`UPDATE jobs SET run_at = now() WHERE name = 'ai_reply' AND status = 'queued'`);
    await drain();
    const conv = await one(`SELECT cv.handling_mode, cv.handover_reason FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.phone = $1`, [phone]);
    expect(conv.handling_mode).toBe('human');
    expect(conv.handover_reason).toMatch(/could not reply/);
  });
});
