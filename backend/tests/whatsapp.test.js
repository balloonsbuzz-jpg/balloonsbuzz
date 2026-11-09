const crypto = require('crypto');
const { app, pool, request, signedIn } = require('./helpers');
const { startMockGraph, graphError } = require('./mock-graph');
const { createWorker } = require('../src/queue/worker-loop');
const handlers = require('../src/queue/handlers');
const jobs = require('../src/queue/jobs');
const { clearRouteCache } = require('../src/whatsapp/account.service');
const { normalizePhone } = require('../src/lib/phone');
const { decrypt } = require('../src/lib/crypto');

const PNID = '109876543210';
const CUSTOMER = '919876500001';
let mock, owner, worker;

beforeAll(async () => {
  mock = await startMockGraph(Number(process.env.GRAPH_MOCK_PORT));
  owner = await signedIn('owner');
  const res = await owner.put('/api/settings/whatsapp', {
    display_phone: '+91 93925 34625', display_name: 'BalloonsBuzz', phone_number_id: PNID, waba_id: '2233445566', access_token: 'EAAui-saved-token-0123456789',
  });
  if (res.status !== 200) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
  clearRouteCache();
  worker = createWorker({ handlers, concurrency: 4, pollMs: 50 });
});
afterAll(async () => { await mock.close(); await pool.end(); });
beforeEach(() => mock.reset());

// ── helpers ──────────────────────────────────────────────────
const sign = (raw, secret = process.env.META_APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
function postWebhook(body, { signature } = {}) {
  const raw = JSON.stringify(body);
  return request(app).post('/webhook/whatsapp').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature ?? sign(raw)).send(raw);
}
const envelope = (value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '2233445566', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919392534625', phone_number_id: PNID }, ...value } }] }],
});
const ts = () => String(Math.floor(Date.now() / 1000));
const inboundText = (id, text, from = CUSTOMER, name = 'Priya') => envelope({
  contacts: [{ profile: { name }, wa_id: from }],
  messages: [{ from, id, timestamp: ts(), type: 'text', text: { body: text } }],
});
const statusEvent = (wamid, status, extra = {}) => envelope({ statuses: [{ id: wamid, status, timestamp: ts(), recipient_id: CUSTOMER, ...extra }] });
const drain = () => worker.drain({ timeoutMs: 30_000 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
// jobs scheduled in the future (retries) are made due immediately for tests
const fastForward = () => pool.query(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);

// ── webhook security ─────────────────────────────────────────
describe('webhook endpoint', () => {
  test('verification echoes the challenge only for the right token', async () => {
    const ok = await request(app).get('/webhook/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token-123', 'hub.challenge': '98765' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('98765');
    const bad = await request(app).get('/webhook/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });

  test('bad or missing signatures are rejected and nothing is stored', async () => {
    const body = inboundText('wamid.SIG1', 'hi');
    expect((await postWebhook(body, { signature: sign(JSON.stringify(body), 'other-secret') })).status).toBe(403);
    expect((await postWebhook(body, { signature: '' })).status).toBe(403);
    expect(await one(`SELECT count(*)::int n FROM webhook_events WHERE event_key = 'msg:wamid.SIG1'`)).toEqual({ n: 0 });
  });

  test('the same delivery three times stores one event, one job, one message', async () => {
    const body = inboundText('wamid.DUP1', 'Hi, do you do birthday decor?');
    for (let i = 0; i < 3; i++) expect((await postWebhook(body)).status).toBe(200);
    expect(await one(`SELECT count(*)::int n FROM webhook_events WHERE event_key = 'msg:wamid.DUP1'`)).toEqual({ n: 1 });
    expect(await one(`SELECT count(*)::int n FROM jobs j JOIN webhook_events w ON w.job_id = j.id WHERE w.event_key = 'msg:wamid.DUP1'`)).toEqual({ n: 1 });
    await drain();
    expect(await one(`SELECT count(*)::int n FROM messages WHERE wa_message_id = 'wamid.DUP1'`)).toEqual({ n: 1 });
  });

  test('acks quickly (persist + queue only; processing happens in the worker)', async () => {
    const t0 = Date.now();
    await postWebhook(inboundText(`wamid.FAST${Date.now()}`, 'quick'));
    // generous bound because the test DB is remote (Supabase); locally this is a few ms
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('events for an unknown number are stored as ignored with no job', async () => {
    const body = inboundText('wamid.UNKNOWN1', 'hi');
    body.entry[0].changes[0].value.metadata.phone_number_id = '999999999999';
    await postWebhook(body);
    expect(await one(`SELECT status, job_id FROM webhook_events WHERE event_key = 'msg:wamid.UNKNOWN1'`)).toEqual({ status: 'ignored', job_id: null });
  });
});

// ── inbound processing ───────────────────────────────────────
describe('inbound messages', () => {
  test('creates contact + conversation + message, opens the 24h window, bumps unread', async () => {
    const phone = '919876500002';
    await postWebhook(inboundText('wamid.IN1', 'Need ring frame decor for Saturday', phone, 'Ravi'));
    await drain();
    const c = await one(`SELECT id, name, phone, last_inbound_at FROM contacts WHERE phone = $1`, [phone]);
    expect(c).toMatchObject({ name: 'Ravi', phone });
    const conv = await one(`SELECT unread_count, last_message_preview, last_message_direction, last_inbound_at FROM conversations WHERE contact_id = $1`, [c.id]);
    expect(conv).toMatchObject({ unread_count: 1, last_message_preview: 'Need ring frame decor for Saturday', last_message_direction: 'inbound' });
    expect(conv.last_inbound_at).not.toBeNull();
    const ev = await one(`SELECT status FROM webhook_events WHERE event_key = 'msg:wamid.IN1'`);
    expect(ev.status).toBe('processed');
  });

  test('location pins, button replies, photos and replies-to are normalised', async () => {
    const phone = '919876500003';
    const contacts = [{ profile: { name: 'Anu' }, wa_id: phone }];
    await postWebhook(envelope({ contacts, messages: [
      { from: phone, id: 'wamid.LOC1', timestamp: ts(), type: 'location', location: { latitude: 17.4948, longitude: 78.3563, name: 'Venue', address: 'Kondapur' } },
      { from: phone, id: 'wamid.BTN1', timestamp: ts(), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'pkg_ring', title: 'Ring frame' } } },
      { from: phone, id: 'wamid.IMG1', timestamp: ts(), type: 'image', image: { id: 'MEDIA123', mime_type: 'image/jpeg', sha256: 'abc', caption: 'like this' }, context: { id: 'wamid.LOC1' } },
    ] }));
    await drain();
    const loc = await one(`SELECT message_type, payload FROM messages WHERE wa_message_id = 'wamid.LOC1'`);
    expect(loc.message_type).toBe('location');
    expect(loc.payload).toMatchObject({ latitude: 17.4948, longitude: 78.3563, address: 'Kondapur' });
    const btn = await one(`SELECT message_type, body, payload FROM messages WHERE wa_message_id = 'wamid.BTN1'`);
    expect(btn).toMatchObject({ message_type: 'interactive', body: 'Ring frame', payload: { kind: 'button_reply', id: 'pkg_ring' } });
    const img = await one(`SELECT m.message_type, m.body, md.wa_media_id, md.mime_type, r.wa_message_id AS reply_to
                             FROM messages m JOIN media md ON md.id = m.media_id LEFT JOIN messages r ON r.id = m.reply_to_message_id
                            WHERE m.wa_message_id = 'wamid.IMG1'`);
    expect(img).toEqual({ message_type: 'image', body: 'like this', wa_media_id: 'MEDIA123', mime_type: 'image/jpeg', reply_to: 'wamid.LOC1' });
  });

  test('a staff-edited contact name is not overwritten by the WhatsApp profile name', async () => {
    const phone = '919876500004';
    await postWebhook(inboundText('wamid.NAME1', 'hi', phone, 'Profile Name'));
    await drain();
    await pool.query(`UPDATE contacts SET name = 'Mrs. Lakshmi (Kukatpally)' WHERE phone = $1`, [phone]);
    await postWebhook(inboundText('wamid.NAME2', 'hello again', phone, 'Profile Name'));
    await drain();
    expect((await one(`SELECT name FROM contacts WHERE phone = $1`, [phone])).name).toBe('Mrs. Lakshmi (Kukatpally)');
  });
});

// ── outbound ─────────────────────────────────────────────────
describe('sending', () => {
  async function conversationWithRecentInbound(phone, wamid) {
    await postWebhook(inboundText(wamid, 'hello', phone));
    await drain();
    return one(`SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.phone = $1`, [phone]);
  }
  const { enqueueMessage } = require('../src/whatsapp/outbound.service');
  const tenantId = async () => (await one(`SELECT id FROM tenants WHERE slug = 'balloonsbuzz'`)).id;

  test('text inside the 24h window is sent with the saved token and gets a wamid', async () => {
    const conv = await conversationWithRecentInbound('919876500010', 'wamid.OUT_IN1');
    const msg = await enqueueMessage({ tenantId: await tenantId(), conversationId: conv.id, type: 'text', content: { text: 'Hi! 🎈 What is the occasion?' }, senderType: 'bot' });
    expect(msg.status).toBe('queued');
    await drain();
    const sent = await one(`SELECT status, wa_message_id FROM messages WHERE id = $1`, [msg.id]);
    expect(sent.status).toBe('sent');
    expect(sent.wa_message_id).toMatch(/^wamid\.MOCK/);
    const req = mock.requests.find((r) => r.method === 'POST' && r.path === `/${require("../src/config/env").env.META_API_VERSION}/${PNID}/messages`);
    expect(req.auth).toBe('Bearer EAAui-saved-token-0123456789');
    expect(req.body).toMatchObject({ messaging_product: 'whatsapp', to: '919876500010', type: 'text', text: { body: 'Hi! 🎈 What is the occasion?' } });
  });

  test('statuses move forward only: read then a late "delivered" keeps read', async () => {
    const conv = await conversationWithRecentInbound('919876500011', 'wamid.OUT_IN2');
    const msg = await enqueueMessage({ tenantId: await tenantId(), conversationId: conv.id, type: 'text', content: { text: 'Here are some designs' }, senderType: 'bot' });
    await drain();
    const { wa_message_id: wamid } = await one(`SELECT wa_message_id FROM messages WHERE id = $1`, [msg.id]);
    await postWebhook(statusEvent(wamid, 'read'));
    await drain();
    await postWebhook(statusEvent(wamid, 'delivered'));
    await drain();
    const m = await one(`SELECT status, delivered_at IS NOT NULL AS has_delivered, read_at IS NOT NULL AS has_read FROM messages WHERE id = $1`, [msg.id]);
    expect(m).toEqual({ status: 'read', has_delivered: true, has_read: true });
  });

  test('rate limits are retried with backoff, then the send succeeds', async () => {
    const conv = await conversationWithRecentInbound('919876500012', 'wamid.OUT_IN3');
    mock.respond(429, { error: { message: 'Rate limit', code: 130429 } }, { 'retry-after': '1' });
    mock.respond(500, { error: { message: 'Internal', code: 2 } });
    const msg = await enqueueMessage({ tenantId: await tenantId(), conversationId: conv.id, type: 'text', content: { text: 'retry me' }, senderType: 'bot' });
    await drain();
    expect((await one(`SELECT status FROM messages WHERE id = $1`, [msg.id])).status).toBe('sending');
    const job = await one(`SELECT status, attempts, run_at > now() AS delayed FROM jobs WHERE payload->>'message_id' = $1`, [msg.id]);
    expect(job).toEqual({ status: 'queued', attempts: 1, delayed: true });
    await fastForward(); await drain();      // 2nd attempt -> 500
    await fastForward(); await drain();      // 3rd attempt -> default success
    expect(await one(`SELECT status, retry_count FROM messages WHERE id = $1`, [msg.id])).toEqual({ status: 'sent', retry_count: 2 });
  });

  test('permanent errors fail immediately with a helpful message (no retries)', async () => {
    const conv = await conversationWithRecentInbound('919876500013', 'wamid.OUT_IN4');
    const e = graphError(131026, 'Message undeliverable');
    mock.respond(e.status, e.body);
    const msg = await enqueueMessage({ tenantId: await tenantId(), conversationId: conv.id, type: 'text', content: { text: 'hello?' }, senderType: 'agent' });
    await drain();
    const m = await one(`SELECT status, error_code, error_message FROM messages WHERE id = $1`, [msg.id]);
    expect(m.status).toBe('failed');
    expect(m.error_code).toBe('131026');
    expect(m.error_message).toMatch(/not be on WhatsApp/);
    expect((await one(`SELECT status, attempts FROM jobs WHERE payload->>'message_id' = $1`, [msg.id]))).toEqual({ status: 'failed', attempts: 1 });
  });

  test('a "failed" status from Meta marks an undelivered message failed', async () => {
    const conv = await conversationWithRecentInbound('919876500014', 'wamid.OUT_IN5');
    const msg = await enqueueMessage({ tenantId: await tenantId(), conversationId: conv.id, type: 'text', content: { text: 'x' }, senderType: 'bot' });
    await drain();
    const { wa_message_id: wamid } = await one(`SELECT wa_message_id FROM messages WHERE id = $1`, [msg.id]);
    await postWebhook(statusEvent(wamid, 'failed', { errors: [{ code: 131047, title: 'Re-engagement message' }] }));
    await drain();
    expect(await one(`SELECT status, error_code FROM messages WHERE id = $1`, [msg.id])).toEqual({ status: 'failed', error_code: '131047' });
  });

  test('outside the 24h window only templates are allowed', async () => {
    const owner2 = owner;
    const res = await owner2.post('/api/settings/whatsapp/test-message', { phone: '+91 98765 00099', type: 'text', text: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe('outside_24h_window');
    const tpl = await owner2.post('/api/settings/whatsapp/test-message', { phone: '+91 98765 00099', type: 'template' });
    expect(tpl.status).toBe(202);
    await drain();
    const req = mock.requests.find((r) => r.body?.type === 'template');
    expect(req.body.template).toEqual({ name: 'hello_world', language: { code: 'en_US' } });
    const status = await owner2.get(`/api/settings/whatsapp/test-message/${tpl.body.message.id}`);
    expect(status.body.message).toMatchObject({ status: 'sent', error_message: null });
  });

  test('payload validation catches WhatsApp limits before sending', async () => {
    const conv = await conversationWithRecentInbound('919876500015', 'wamid.OUT_IN6');
    const tid = await tenantId();
    await expect(enqueueMessage({ tenantId: tid, conversationId: conv.id, type: 'buttons', content: { text: 'Pick', buttons: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }] }, senderType: 'bot' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(enqueueMessage({ tenantId: tid, conversationId: conv.id, type: 'image', content: { link: 'http://insecure/x.jpg' }, senderType: 'bot' }))
      .rejects.toMatchObject({ status: 400 });
    const loc = await enqueueMessage({ tenantId: tid, conversationId: conv.id, type: 'location_request', content: {}, senderType: 'bot' });
    await drain();
    const req = mock.requests.find((r) => r.body?.interactive?.type === 'location_request_message');
    expect(req.body.interactive.action).toEqual({ name: 'send_location' });
    expect((await one(`SELECT status FROM messages WHERE id = $1`, [loc.id])).status).toBe('sent');
  });
});

// ── queue ────────────────────────────────────────────────────
describe('job queue', () => {
  test('two workers never claim the same job', async () => {
    const tid = (await one(`SELECT id FROM tenants WHERE slug = 'balloonsbuzz'`)).id;
    for (let i = 0; i < 10; i++) await jobs.enqueue({ tenantId: tid, name: 'noop_test', queue: 'test_q' });
    const [a, b] = await Promise.all([
      jobs.claim({ workerId: 'A', queues: ['test_q'], limit: 10 }),
      jobs.claim({ workerId: 'B', queues: ['test_q'], limit: 10 }),
    ]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  test('stale running jobs are recovered; unique keys dedupe', async () => {
    const j = await jobs.enqueue({ name: 'noop_test', queue: 'test_q2', uniqueKey: 'reminder:abc' });
    expect(await jobs.enqueue({ name: 'noop_test', queue: 'test_q2', uniqueKey: 'reminder:abc' })).toBeNull();
    await jobs.claim({ workerId: 'dead', queues: ['test_q2'] });
    await pool.query(`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = $1`, [j.id]);
    expect(await jobs.recoverStale()).toBeGreaterThanOrEqual(1);
    expect((await one(`SELECT status FROM jobs WHERE id = $1`, [j.id])).status).toBe('queued');
  });

  test('backoff grows and is capped', () => {
    const d = [1, 2, 3, 4, 20].map((n) => jobs.backoffMs(n));
    expect(d[1]).toBeGreaterThan(d[0]);
    expect(d[3]).toBeGreaterThan(d[2]);
    expect(d[4]).toBeLessThanOrEqual(12 * 60_000);
  });
});

// ── settings ─────────────────────────────────────────────────
describe('WhatsApp settings', () => {
  test('the saved token is encrypted and never returned', async () => {
    const res = await owner.get('/api/settings/whatsapp');
    expect(res.body.account).toMatchObject({ phone_number_id: PNID, display_phone: '919392534625', token_source: 'ui', has_saved_token: true });
    expect(JSON.stringify(res.body)).not.toMatch(/EAAui|access_token_enc/);
    const row = await one(`SELECT access_token_enc FROM whatsapp_accounts WHERE phone_number_id = $1`, [PNID]);
    expect(decrypt(row.access_token_enc)).toBe('EAAui-saved-token-0123456789');
    expect(res.body.webhook).toMatchObject({ callback_url: 'https://wa.example.test/webhook/whatsapp', verify_token_configured: true, app_secret_configured: true });
  });

  test('health check asks Meta and stores the result', async () => {
    const res = await owner.post('/api/settings/whatsapp/health');
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, verified_name: 'BalloonsBuzz', quality_rating: 'GREEN' });
    expect(res.body.account.status).toBe('connected');
    const e = graphError(190, 'Invalid OAuth access token');
    mock.respond(e.status, e.body);
    const bad = await owner.post('/api/settings/whatsapp/health');
    expect(bad.body.result).toMatchObject({ ok: false, code: 190 });
    expect(bad.body.result.error).toMatch(/token is invalid or expired/);
    expect(bad.body.account.status).toBe('error');
  });

  test('validation explains the common mix-up of phone number vs phone number ID', async () => {
    const res = await owner.put('/api/settings/whatsapp', { display_phone: '9392534625', phone_number_id: '+91 93925 34625', waba_id: '2233445566' });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toMatch(/numeric ID from Meta/);
  });

  test('agents cannot change WhatsApp settings', async () => {
    const agent = await signedIn('agent');
    expect((await agent.put('/api/settings/whatsapp', { display_phone: '919392534625', phone_number_id: PNID, waba_id: '1' })).status).toBe(403);
  });
});

describe('phone normalisation', () => {
  test.each([
    ['+91 93925 34625', '919392534625'], ['9392534625', '919392534625'], ['09392534625', '919392534625'],
    ['0091 93925-34625', '919392534625'], ['+1 (415) 555-0100', '14155550100'], ['12345', null], ['', null],
  ])('%s -> %s', (input, out) => expect(normalizePhone(input)).toBe(out));
});
