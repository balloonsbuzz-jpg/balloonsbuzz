// M8: template sync, tags + opt-out, broadcasts (schedule, pause, retry, counts), automations.
const { pool, signedIn } = require('./helpers');
const { startMockGraph, graphError } = require('./mock-graph');
const { postWebhook, inboundText, envelope, ensureAccount, ts } = require('./wa-helpers');
const { createWorker } = require('../src/queue/worker-loop');
const handlers = require('../src/queue/handlers');
const broadcasts = require('../src/broadcasts/broadcasts.service');
const automations = require('../src/automations/automations.service');
const { HANDLERS } = require('../src/agent/tools/handlers');
const { env } = require('../src/config/env');
const bus = require('../src/realtime/bus');

let graph; let owner; let agent; let worker; let tenantId; let accountId;
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const drain = () => worker.drain({ timeoutMs: 30_000 });
let seq = 0;

/** A customer who messaged us (returns contact + conversation ids). */
async function customer(name) {
  seq += 1;
  const phone = `9197${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`.slice(0, 12);
  await postWebhook(inboundText(`wamid.MK${Date.now()}${seq}`, 'Hi', phone, name));
  await drain();
  const r = await one(`SELECT ct.id AS contact_id, cv.id AS conversation_id, ct.phone FROM contacts ct JOIN conversations cv ON cv.contact_id = ct.id WHERE ct.phone = $1`, [phone]);
  return { ...r, name };
}
const say = async (c, text) => { await postWebhook(inboundText(`wamid.MKS${Date.now()}${++seq}`, text, c.phone, c.name)); await drain(); };
const status = (wamid, st) => postWebhook(envelope({ statuses: [{ id: wamid, status: st, timestamp: ts(), recipient_id: '1' }] }));

const TEMPLATE_LIST = (extra = []) => ({
  data: [
    { id: 'm1', name: 'bb_booking_confirmed', language: 'en', status: 'APPROVED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hi {{1}}, booking {{2}} confirmed. Date {{3}}, venue {{4}}. Paid {{5}}, balance {{6}}.' }] },
    { id: 'm2', name: 'diwali_offer', language: 'en', status: 'APPROVED', category: 'MARKETING',
      components: [{ type: 'BODY', text: 'Hi {{1}} 🪔 {{2}} on all balloon decorations this Diwali! Reply to book.' }] },
    ...extra,
  ],
  paging: {},
});

beforeAll(async () => {
  graph = await startMockGraph(Number(process.env.GRAPH_MOCK_PORT));
  owner = await signedIn('owner');
  agent = await signedIn('agent');
  ({ id: tenantId } = await one(`SELECT id FROM tenants WHERE slug = 'balloonsbuzz'`));
  await ensureAccount(owner);
  ({ id: accountId } = await one(`SELECT id FROM whatsapp_accounts WHERE tenant_id = $1 AND is_primary`, [tenantId]));
  worker = createWorker({ handlers, concurrency: 4, pollMs: 50 });
});
afterAll(async () => {
  await pool.query(`UPDATE automations SET is_active = false WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`UPDATE business_settings SET staff_alert_phones = '{}' WHERE tenant_id = $1`, [tenantId]);
  await bus.stop(); await graph.close(); await pool.end();
});
beforeEach(() => graph.reset());

describe('templates', () => {
  test('sync from Meta: approved, rejected and later-deleted templates; admin settings survive', async () => {
    graph.respond(200, TEMPLATE_LIST([{ id: 'm3', name: 'old_promo', language: 'en', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', category: 'MARKETING', components: [] }]));
    const r = await owner.post('/api/templates/sync', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 3, added: 3 });
    const req = graph.requests[0];
    expect(req.path).toBe(`/${env.META_API_VERSION}/2233445566/message_templates`);
    expect(req.url).toMatch(/fields=id%2Cname%2Clanguage%2Cstatus/);
    const conf = r.body.templates.find((t) => t.name === 'bb_booking_confirmed');
    expect(conf).toMatchObject({ status: 'approved', purpose: 'booking_confirmation', placeholders: [1, 2, 3, 4, 5, 6] });
    expect(conf.variable_map).toMatchObject({ 1: 'contact.first_name', 2: 'booking.code' });
    expect(r.body.templates.find((t) => t.name === 'old_promo')).toMatchObject({ status: 'rejected', rejected_reason: 'INVALID_FORMAT' });

    const diwali = r.body.templates.find((t) => t.name === 'diwali_offer');
    expect((await owner.patch(`/api/templates/${diwali.id}`, { variable_map: { 3: 'contact.name' } })).status).toBe(400);
    expect((await owner.patch(`/api/templates/${diwali.id}`, { variable_map: { 1: 'nope' } })).status).toBe(400);
    expect((await owner.patch(`/api/templates/${diwali.id}`, { purpose: 'event_reminder', variable_map: { 1: 'contact.first_name', 2: 'static' } })).status).toBe(400);
    const ok = await owner.patch(`/api/templates/${diwali.id}`, { purpose: 'broadcast', variable_map: { 1: 'contact.first_name', 2: 'static' } });
    expect(ok.status).toBe(200);

    graph.respond(200, TEMPLATE_LIST());                       // old_promo deleted at Meta
    const again = await owner.post('/api/templates/sync', {});
    expect(again.body).toMatchObject({ added: 0, updated: 2 });
    expect(again.body.templates.find((t) => t.name === 'old_promo').status).toBe('disabled');
    expect(again.body.templates.find((t) => t.name === 'diwali_offer')).toMatchObject({ purpose: 'broadcast', variable_map: { 1: 'contact.first_name', 2: 'static' } });
    expect((await agent.post('/api/templates/sync', {})).status).toBe(403);
  });

  test('submit a recommended template to Meta for approval', async () => {
    graph.respond(200, { id: 'm9', status: 'PENDING', category: 'UTILITY' });
    const r = await owner.post('/api/templates/recommended/bb_event_reminder', {});
    expect(r.status).toBe(201);
    expect(r.body.template).toMatchObject({ name: 'bb_event_reminder', status: 'pending', purpose: 'event_reminder' });
    const body = graph.requests[0].body;
    expect(body).toMatchObject({ name: 'bb_event_reminder', category: 'UTILITY', language: 'en' });
    expect(body.components[0].example.body_text[0]).toHaveLength(5);
  });

  test('without a connected number the page is told to connect it (not a server error)', async () => {
    const { status } = await one(`SELECT status FROM whatsapp_accounts WHERE is_primary`);
    await pool.query(`UPDATE whatsapp_accounts SET status = 'disconnected' WHERE is_primary`);
    try {
      for (const r of [await owner.post('/api/templates/recommended/bb_review_request', {}), await owner.post('/api/templates/sync', {})]) {
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/Connect your WhatsApp number first/);
      }
      expect(graph.requests).toHaveLength(0);
    } finally {
      await pool.query(`UPDATE whatsapp_accounts SET status = $1 WHERE is_primary`, [status]);
    }
  });
});

describe('tags and opt-out', () => {
  test('tag customers; STOP opts out (with a reply, no AI) and START opts back in', async () => {
    const a = await customer('Asha Rao');
    const t = await agent.put(`/api/contacts/${a.contact_id}/tags`, { names: ['Diwali 2026', 'repeat'] });
    expect(t.status).toBe(200);
    expect(t.body.tags.map((x) => x.name)).toEqual(['Diwali 2026', 'repeat']);
    expect((await agent.put(`/api/contacts/${a.contact_id}/tags`, { names: ['diwali 2026'] })).body.tags).toHaveLength(1);   // case-insensitive, same tag

    await say(a, 'STOP');
    expect(await one(`SELECT opted_in FROM contacts WHERE id = $1`, [a.contact_id])).toEqual({ opted_in: false });
    const reply = await one(`SELECT sender_type, body FROM messages WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1`, [a.conversation_id]);
    expect(reply).toMatchObject({ sender_type: 'system' });
    expect(reply.body).toMatch(/won’t receive offers/);
    expect(await one(`SELECT count(*)::int AS n FROM jobs WHERE name = 'ai_reply' AND payload->>'conversation_id' = $1 AND created_at > now() - interval '1 minute'`, [a.conversation_id])).toEqual({ n: 1 });   // only the first "Hi"

    await say(a, 'start');
    expect(await one(`SELECT opted_in FROM contacts WHERE id = $1`, [a.contact_id])).toEqual({ opted_in: true });
  });
});

describe('broadcasts', () => {
  let tagId; let diwaliId; let c1; let c2; let c3;
  beforeAll(async () => {
    c1 = await customer('Priya Sharma'); c2 = await customer('Rahul Verma'); c3 = await customer('Sneha (opted out)');
    for (const c of [c1, c2, c3]) await owner.put(`/api/contacts/${c.contact_id}/tags`, { names: ['vip'] });
    ({ id: tagId } = await one(`SELECT id FROM tags WHERE tenant_id = $1 AND lower(name) = 'vip'`, [tenantId]));
    await say(c3, 'unsubscribe');
    ({ id: diwaliId } = await one(`SELECT id FROM templates WHERE name = 'diwali_offer'`));
  });

  test('audience preview excludes opted-out customers', async () => {
    const r = await owner.post('/api/broadcasts/audience', { tags_any: [tagId] });
    expect(r.body).toMatchObject({ count: 2, opted_out_excluded: 1 });
    expect(r.body.sample.map((s) => s.name).sort()).toEqual(['Priya Sharma', 'Rahul Verma']);
  });

  test('a template that is not ready is refused', async () => {
    const tpl = await one(`SELECT id FROM templates WHERE name = 'diwali_offer'`);
    expect((await owner.post('/api/broadcasts', { name: 'No text', template_id: tpl.id, audience_filter: { tags_any: [tagId] } })).status).toBe(400);   // {{2}} static text missing
    const conf = await one(`SELECT id FROM templates WHERE name = 'bb_booking_confirmed'`);
    expect((await owner.post('/api/broadcasts', { name: 'Wrong', template_id: conf.id, audience_filter: {} })).body.error).toMatch(/booking field/);
  });

  test('send now: personalised templates go out; delivery, read and reply are counted; opt-outs are never messaged', async () => {
    const created = await owner.post('/api/broadcasts', { name: 'Diwali VIP', template_id: diwaliId, variables: { 2: '20% off' }, audience_filter: { tags_any: [tagId] } });
    expect(created.status).toBe(201);
    const id = created.body.broadcast.id;
    expect((await owner.post(`/api/broadcasts/${id}/schedule`, {})).body.broadcast.status).toBe('scheduled');
    await drain();

    const sent = graph.requests.filter((r) => r.body?.type === 'template');
    expect(sent).toHaveLength(2);
    expect(sent.map((r) => r.body.to).sort()).toEqual([c1.phone, c2.phone].sort());
    const priya = sent.find((r) => r.body.to === c1.phone);
    expect(priya.body.template).toMatchObject({ name: 'diwali_offer', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Priya' }, { type: 'text', text: '20% off' }] }] });

    let b = (await owner.get(`/api/broadcasts/${id}`)).body;
    expect(b.broadcast).toMatchObject({ status: 'completed', total_count: 2, sent_count: 2, skipped_count: 0 });
    const msg = await one(`SELECT body FROM messages WHERE conversation_id = $1 AND message_type = 'template'`, [c1.conversation_id]);
    expect(msg.body).toBe('Hi Priya 🪔 20% off on all balloon decorations this Diwali! Reply to book.');

    const wamid = (await one(`SELECT wa_message_id FROM broadcast_recipients WHERE broadcast_id = $1 AND phone = $2`, [id, c1.phone])).wa_message_id;
    await status(wamid, 'delivered'); await status(wamid, 'read'); await drain();
    await say(c1, 'Interested! What designs?');
    b = (await owner.get(`/api/broadcasts/${id}`)).body;
    expect(b.broadcast).toMatchObject({ delivered_count: 1, read_count: 1, replied_count: 1 });
    expect((await owner.get(`/api/broadcasts/${id}?status=replied`)).body.recipients.map((r) => r.phone)).toEqual([c1.phone]);
  });

  test('someone who opts out after the broadcast starts is skipped', async () => {
    const c4 = await customer('Late Optout');
    await owner.put(`/api/contacts/${c4.contact_id}/tags`, { names: ['late'] });
    const { id: lateTag } = await one(`SELECT id FROM tags WHERE lower(name) = 'late'`);
    const { body: { broadcast } } = await owner.post('/api/broadcasts', { name: 'Late', template_id: diwaliId, variables: { 2: 'Free name board' }, audience_filter: { tags_any: [lateTag] } });
    await pool.query(`UPDATE broadcasts SET status = 'scheduled', scheduled_at = now() WHERE id = $1`, [broadcast.id]);
    await broadcasts.startJob({ broadcast_id: broadcast.id });      // audience frozen: c4 is pending
    await pool.query(`UPDATE contacts SET opted_in = false, opted_out_at = now() WHERE id = $1`, [c4.contact_id]);
    await broadcasts.batchJob({ broadcast_id: broadcast.id });
    const r = await one(`SELECT status, error_message FROM broadcast_recipients WHERE broadcast_id = $1`, [broadcast.id]);
    expect(r).toEqual({ status: 'skipped', error_message: 'Opted out' });
    expect((await broadcasts.get(tenantId, broadcast.id)).status).toBe('completed');
    await pool.query(`UPDATE contacts SET opted_in = true, opted_out_at = NULL WHERE id = $1`, [c4.contact_id]);
  });

  test('pause holds back unsent messages; resume finishes the job', async () => {
    await pool.query(`INSERT INTO tags (tenant_id, name) VALUES ($1, 'bulk') ON CONFLICT DO NOTHING`, [tenantId]);
    const { id: bulk } = await one(`SELECT id FROM tags WHERE lower(name) = 'bulk'`);
    const stamp = String(Date.now()).slice(-5);
    await pool.query(
      `WITH c AS (INSERT INTO contacts (tenant_id, phone, name, source)
                  SELECT $1, '91955' || $2 || lpad(i::text, 2, '0'), 'Bulk ' || i, 'import' FROM generate_series(0, 29) i RETURNING id)
       INSERT INTO contact_tags (contact_id, tag_id, tenant_id) SELECT id, $3, $1 FROM c`, [tenantId, stamp, bulk]);

    const { body: { broadcast } } = await owner.post('/api/broadcasts', { name: 'Bulk', template_id: diwaliId, variables: { 2: '10% off' }, audience_filter: { tags_any: [bulk] } });
    await pool.query(`UPDATE broadcasts SET status = 'scheduled', scheduled_at = now() WHERE id = $1`, [broadcast.id]);
    await broadcasts.startJob({ broadcast_id: broadcast.id });
    await pool.query(`DELETE FROM jobs WHERE name = 'broadcast_batch' AND payload->>'broadcast_id' = $1`, [broadcast.id]);
    await broadcasts.batchJob({ broadcast_id: broadcast.id });                           // first 25 queued, not sent yet
    await pool.query(`DELETE FROM jobs WHERE name = 'broadcast_batch' AND payload->>'broadcast_id' = $1`, [broadcast.id]);
    expect((await broadcasts.get(tenantId, broadcast.id)).total_count).toBe(30);

    const p = await owner.post(`/api/broadcasts/${broadcast.id}/pause`, {});
    expect(p.body.broadcast.status).toBe('paused');
    await worker.drain({ timeoutMs: 120_000 });
    expect(graph.requests.filter((r) => r.body?.type === 'template')).toHaveLength(0);   // nothing slipped out
    expect(await one(`SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'pending'`, [broadcast.id])).toEqual({ n: 30 });

    expect((await owner.post(`/api/broadcasts/${broadcast.id}/resume`, {})).body.broadcast.status).toBe('running');
    // 30 sends over a far-away test database take a while: give the queue more time
    await worker.drain({ timeoutMs: 150_000 });
    expect(graph.requests.filter((r) => r.body?.type === 'template')).toHaveLength(30);
    expect(await broadcasts.get(tenantId, broadcast.id)).toMatchObject({ status: 'completed', sent_count: 30 });
  }, 400_000);

  test('failed sends can be retried', async () => {
    const c5 = await customer('Retry Me');
    await owner.put(`/api/contacts/${c5.contact_id}/tags`, { names: ['retry'] });
    const { id: tag } = await one(`SELECT id FROM tags WHERE lower(name) = 'retry'`);
    graph.respond(400, graphError(131026, 'Message undeliverable').body);
    const { body: { broadcast } } = await owner.post('/api/broadcasts', { name: 'Retry', template_id: diwaliId, variables: { 2: 'Offer' }, audience_filter: { tags_any: [tag] } });
    await owner.post(`/api/broadcasts/${broadcast.id}/schedule`, {});
    await drain();
    let b = await broadcasts.get(tenantId, broadcast.id);
    expect(b).toMatchObject({ status: 'completed', failed_count: 1, sent_count: 0 });
    const retry = await owner.post(`/api/broadcasts/${broadcast.id}/retry-failed`, {});
    expect(retry.body.retried).toBe(1);
    await drain();
    b = await broadcasts.get(tenantId, broadcast.id);
    expect(b).toMatchObject({ status: 'completed', failed_count: 0, sent_count: 1 });
  });

  test('scheduled for later, then cancelled: nothing is sent', async () => {
    const { body: { broadcast } } = await owner.post('/api/broadcasts', { name: 'Later', template_id: diwaliId, variables: { 2: 'x' }, audience_filter: { tags_any: [tagId] } });
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect((await owner.post(`/api/broadcasts/${broadcast.id}/schedule`, { at })).body.broadcast.status).toBe('scheduled');
    expect((await owner.post(`/api/broadcasts/${broadcast.id}/cancel`, {})).body.broadcast.status).toBe('cancelled');
    await pool.query(`UPDATE jobs SET run_at = now() WHERE name = 'broadcast_start' AND payload->>'broadcast_id' = $1`, [broadcast.id]);
    await drain();
    expect(await broadcasts.get(tenantId, broadcast.id)).toMatchObject({ status: 'cancelled', total_count: 0 });
    expect((await agent.post('/api/broadcasts', { name: 'x', template_id: diwaliId })).status).toBe(403);
  });
});

describe('automations and follow-ups', () => {
  const istIn = (hours) => {
    const d = new Date(Date.now() + 330 * 60_000 + hours * 3600_000);
    return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
  };
  async function booking(c, { status: st = 'confirmed', inHours = 10, advance = 3000, createdHoursAgo = 0 } = {}) {
    const { date, time } = istIn(inHours);
    const { id: pkg } = await one(`SELECT id FROM packages WHERE key = 'semi_arch'`);
    const { rows: [b] } = await pool.query(
      `INSERT INTO bookings (tenant_id, contact_id, package_id, event_date, event_time, venue_address, quoted_price, agreed_price, floor_price, advance_amount, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'Flat 9, Kondapur',10000,10000,9000,$6,$7, now() - make_interval(hours => $8)) RETURNING *`,
      [tenantId, c.contact_id, pkg, date, time, advance, st, createdHoursAgo]);
    return b;
  }
  const setAuto = (key, patch) => pool.query(`UPDATE automations SET is_active = $2, trigger_config = trigger_config || $3::jsonb WHERE tenant_id = $1 AND key = $4`,
    [tenantId, patch.is_active ?? true, JSON.stringify(patch.trigger_config || {}), key]);

  test('the event reminder is sent once per booking, however often the check runs', async () => {
    const c = await customer('Event Soon');
    const b = await booking(c, { inHours: 10 });
    await setAuto('event_reminder', { trigger_config: { offset_hours: -24 } });
    await automations.runDue({ tenantId });
    await automations.runDue({ tenantId });
    await owner.post('/api/automations/run', {});
    expect(await one(`SELECT count(*)::int AS n FROM followups WHERE booking_id = $1`, [b.id])).toEqual({ n: 1 });
    await drain();
    const f = await one(`SELECT status, kind, message_id FROM followups WHERE booking_id = $1`, [b.id]);
    expect(f).toMatchObject({ status: 'sent', kind: 'event_reminder' });
    const m = await one(`SELECT body, sender_type FROM messages WHERE id = $1`, [f.message_id]);
    expect(m.body).toMatch(/Flat 9, Kondapur/);
    expect(m.body).toMatch(/Balance on the day: ₹10,000/);
    await automations.runDue({ tenantId });
    expect(await one(`SELECT count(*)::int AS n FROM followups WHERE booking_id = $1`, [b.id])).toEqual({ n: 1 });
    await setAuto('event_reminder', { is_active: false });
  });

  test('a quote nudge is cancelled when the customer replies first, and sent when they stay quiet', async () => {
    await setAuto('quote_nudge_3h', { trigger_config: { delay_minutes: 180 } });
    const quiet = await customer('Quiet Quinn');
    const busy = await customer('Busy Bee');
    for (const c of [quiet, busy]) {
      const ctx = { tenantId, conversationId: c.conversation_id, runId: null, allowed: new Set(), nextDelay: () => 0, toolConfig: {} };
      const q = await HANDLERS.get_pricing({ package_key: 'semi_arch' }, ctx);
      await pool.query(`UPDATE quotes SET created_at = now() - interval '4 hours' WHERE id = $1`, [q.quote_id]);
      await pool.query(`UPDATE messages SET created_at = now() - interval '5 hours' WHERE conversation_id = $1`, [c.conversation_id]);
    }
    await automations.runDue({ tenantId });
    // the follow-ups are queued; one customer replies before they go out
    await pool.query(`UPDATE jobs SET run_at = now() + interval '1 hour' WHERE name = 'send_followup' AND status = 'queued'`);
    await postWebhook(inboundText(`wamid.BUSY${Date.now()}`, 'Sorry, was busy. Is Sunday ok?', busy.phone, busy.name));
    await drain();
    await pool.query(`UPDATE jobs SET run_at = now() WHERE name = 'send_followup' AND status = 'queued'`);
    await drain();
    const fq = await one(`SELECT f.status, m.body FROM followups f LEFT JOIN messages m ON m.id = f.message_id WHERE f.conversation_id = $1`, [quiet.conversation_id]);
    expect(fq).toMatchObject({ status: 'sent', body: 'Hi Quiet 👋 Did you get a chance to look at the designs? Happy to help you pick one 🎈' });
    const fb = await one(`SELECT status, cancel_reason FROM followups WHERE conversation_id = $1`, [busy.conversation_id]);
    expect(fb).toEqual({ status: 'cancelled', cancel_reason: 'customer replied' });
    await setAuto('quote_nudge_3h', { is_active: false });
  });

  test('advance reminder after the delay, with the amount still due and the UPI ID', async () => {
    await pool.query(`UPDATE business_settings SET upi_vpa = 'balloonsbuzz@okhdfc' WHERE tenant_id = $1`, [tenantId]);
    const c = await customer('Advance Due');
    const b = await booking(c, { status: 'advance_pending', inHours: 24 * 10, createdHoursAgo: 13 });
    await setAuto('advance_reminder', { trigger_config: { delay_minutes: 720 } });
    await automations.runDue({ tenantId });
    await drain();
    const f = await one(`SELECT f.status, m.body FROM followups f JOIN messages m ON m.id = f.message_id WHERE f.booking_id = $1`, [b.id]);
    expect(f.status).toBe('sent');
    expect(f.body).toMatch(/₹3,000/);
    expect(f.body).toMatch(/balloonsbuzz@okhdfc/);
    await setAuto('advance_reminder', { is_active: false });
  });

  test('handover alerts the team phones with the approved template', async () => {
    await pool.query(
      `INSERT INTO templates (tenant_id, whatsapp_account_id, name, language, category, status, purpose, components, variable_map)
       VALUES ($1,$2,'bb_handover_alert','en','UTILITY','approved','handover_alert',$3,$4)`,
      [tenantId, accountId, JSON.stringify([{ type: 'BODY', text: 'Chat needs a person: {{1}} ({{2}}). Reason: {{3}}.' }]),
        JSON.stringify({ 1: 'contact.name', 2: 'contact.phone', 3: 'handover.reason' })]);
    await pool.query(`UPDATE business_settings SET staff_alert_phones = '{919392534625}' WHERE tenant_id = $1`, [tenantId]);
    await setAuto('handover_staff_alert', {});
    const c = await customer('Needs Human');
    graph.reset();
    await say(c, 'Can I talk to a person please');
    const alert = graph.requests.find((r) => r.body?.type === 'template' && r.body.to === '919392534625');
    expect(alert.body.template).toMatchObject({ name: 'bb_handover_alert' });
    expect(alert.body.template.components[0].parameters.map((p) => p.text)).toEqual(['Needs Human', `+${c.phone}`, 'Customer asked for a person ("talk to a person")']);
    await setAuto('handover_staff_alert', { is_active: false });
  });

  test('automation settings are validated; follow-ups can be listed and cancelled', async () => {
    const list = (await owner.get('/api/automations')).body.automations;
    const nudge = list.find((a) => a.key === 'quote_nudge_3h');
    expect((await owner.patch(`/api/automations/${nudge.id}`, { action_config: { text: 'Only ₹5,000 today!' } })).status).toBe(400);
    expect((await owner.patch(`/api/automations/${nudge.id}`, { trigger_config: { delay_minutes: 1 } })).status).toBe(400);
    expect((await owner.patch(`/api/automations/${nudge.id}`, { trigger_config: { offset_hours: 5 } })).status).toBe(400);
    const ok = await owner.patch(`/api/automations/${nudge.id}`, { trigger_config: { delay_minutes: 240 }, action_config: { text: 'Hi {{contact.first_name}}, still thinking? 🎈' } });
    expect(ok.body.automation).toMatchObject({ trigger_config: { delay_minutes: 240 }, action_config: { text: 'Hi {{contact.first_name}}, still thinking? 🎈' } });

    const c = await customer('Pending One');
    await pool.query(
      `INSERT INTO followups (tenant_id, contact_id, conversation_id, kind, idempotency_key, scheduled_at, content)
       VALUES ($1,$2,$3,'agent_scheduled',$4, now() + interval '2 days', '{"type":"text","text":"hello"}')`, [tenantId, c.contact_id, c.conversation_id, `t:${c.contact_id}`]);
    const pending = (await owner.get('/api/followups?status=pending')).body.followups.find((f) => f.contact_name === 'Pending One');
    expect(pending).toBeTruthy();
    expect((await owner.post(`/api/followups/${pending.id}/cancel`, {})).status).toBe(200);
    expect((await owner.post(`/api/followups/${pending.id}/cancel`, {})).status).toBe(400);
  });
});
