// Connect number: Embedded Signup (new number / coexistence), coexistence webhooks, and the
// cross-origin dashboard (CORS, cron endpoint).
const { app, pool, request, signedIn } = require('./helpers');
const { startMockGraph, graphError } = require('./mock-graph');
const { PNID, postWebhook, inboundText, ts } = require('./wa-helpers');
const { createWorker } = require('../src/queue/worker-loop');
const handlers = require('../src/queue/handlers');
const { decrypt } = require('../src/lib/crypto');
const { routeByPhoneNumberId } = require('../src/whatsapp/account.service');

const WABA = '2233445566';
const APP_ID = process.env.META_APP_ID;
const TOKEN = 'EAAbusiness-token-from-meta-01';
let mock, owner, worker, meta;

beforeAll(async () => {
  mock = await startMockGraph(Number(process.env.GRAPH_MOCK_PORT));
  owner = await signedIn('owner');
  worker = createWorker({ handlers, concurrency: 2, pollMs: 50 });
});
afterAll(async () => { await mock.close(); await pool.end(); });

beforeEach(() => {
  mock.reset();
  // A small model of Meta; each test changes what it needs.
  meta = {
    targets: [WABA], appId: APP_ID, subscribed: [],
    numbers: [{ id: PNID, display_phone_number: '+91 93925 34625', verified_name: 'BalloonsBuzz', platform_type: 'NOT_APPLICABLE', status: 'PENDING', is_on_biz_app: false }],
    fail: {},
  };
  mock.setDefault((req) => {
    const key = `${req.method} ${req.path.replace(/^\/v[\d.]+\//, '')}`;
    if (meta.fail[key]) return meta.fail[key];
    const ok = (body) => ({ status: 200, body });
    switch (key) {
      case 'GET oauth/access_token': return ok({ access_token: TOKEN, token_type: 'bearer' });
      case 'GET debug_token': return ok({ data: { is_valid: true, app_id: meta.appId, granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: meta.targets }] } });
      case `GET ${WABA}/phone_numbers`: return ok({ data: meta.numbers });
      case `GET ${WABA}/subscribed_apps`: return ok({ data: meta.subscribed });
      case `POST ${PNID}/smb_app_data`: return ok({ messaging_product: 'whatsapp', request_id: `req-${req.body.sync_type}` });
      default: return ok(req.method === 'GET' ? { ...meta.numbers[0] } : { success: true });
    }
  });
});

const calls = (method, re) => mock.requests.filter((r) => r.method === method && re.test(r.path));
const connect = (body = {}) => owner.post('/api/settings/whatsapp/embedded-signup', { code: 'one-time-code-123', mode: 'new', ...body });
const row = async () => (await pool.query(`SELECT * FROM whatsapp_accounts WHERE is_primary`)).rows[0];
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const drain = () => worker.drain({ timeoutMs: 20_000 });
const change = (field, value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919392534625', phone_number_id: PNID }, ...value } }] }],
});

describe('embedded signup: new number', () => {
  test('the dashboard gets only public ids, never the secret or the verify token', async () => {
    const res = await owner.get('/api/settings/whatsapp/signup-config');
    expect(res.body).toMatchObject({ enabled: true, missing: [], app_id: APP_ID, config_id: process.env.META_SIGNUP_CONFIG_ID });
    expect(JSON.stringify(res.body)).not.toMatch(/test-app-secret|test-verify-token/);
  });

  test('saves the number, points only this number\'s webhook here and registers it', async () => {
    const res = await connect({ waba_id: WABA, phone_number_id: PNID });
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ phone_number_id: PNID, waba_id: WABA, display_phone: '919392534625', status: 'connected', connection_type: 'embedded', is_coexistence: false, token_source: 'ui' });
    expect(res.body.account.setup_steps.map((s) => [s.key, s.ok])).toEqual([['subscribe', true], ['webhook', true], ['register', true], ['check', true]]);
    expect(JSON.stringify(res.body)).not.toMatch(/EAAbusiness|_enc/);

    // app-wide subscription carries no override (Whapter keeps its webhook) ...
    expect(calls('POST', /subscribed_apps$/)[0].body).toBeNull();
    // ... the override is on the phone number
    const phoneCall = calls('POST', new RegExp(`/${PNID}$`))[0];
    expect(phoneCall.body).toEqual({ webhook_configuration: { override_callback_uri: 'https://wa.example.test/webhook/whatsapp', verify_token: 'test-verify-token-123' } });
    expect(phoneCall.auth).toBe(`Bearer ${TOKEN}`);

    const acc = await row();
    expect(decrypt(acc.access_token_enc)).toBe(TOKEN);
    const { pin } = calls('POST', /register$/)[0].body;
    expect(pin).toMatch(/^\d{6}$/);
    expect(decrypt(acc.two_step_pin_enc)).toBe(pin);
    expect(calls('POST', /smb_app_data/)).toHaveLength(0);
  });

  test('ids missing from the popup are found from the token', async () => {
    const res = await connect();
    expect(res.status).toBe(200);
    expect(res.body.account.phone_number_id).toBe(PNID);
  });

  test('an already subscribed, already registered number is left alone', async () => {
    meta.subscribed = [{ whatsapp_business_api_data: { id: APP_ID } }];
    Object.assign(meta.numbers[0], { platform_type: 'CLOUD_API', status: 'CONNECTED' });
    expect((await connect()).body.account.status).toBe('connected');
    expect(calls('POST', /subscribed_apps$/)).toHaveLength(0);
    expect(calls('POST', /register$/)).toHaveLength(0);
  });

  test('a wrong PIN keeps the number and explains what to do; finishing with the PIN connects it', async () => {
    meta.fail[`POST ${PNID}/register`] = graphError(133005, 'Two step verification PIN Mismatch');
    const res = await connect();
    expect(res.status).toBe(200);
    expect(res.body.account.status).toBe('error');
    expect(res.body.account.setup_steps.find((s) => s.key === 'register').error).toMatch(/already has a two-step verification PIN/);
    meta.fail = {};
    mock.requests.length = 0;
    const done = await owner.post('/api/settings/whatsapp/finish-setup', { pin: '445566' });
    expect(done.body.account.status).toBe('connected');
    expect(calls('POST', /register$/)[0].body.pin).toBe('445566');
    expect(calls('GET', /oauth/)).toHaveLength(0);
  });

  test('a login for another app, or an account that was not shared, is refused and nothing is saved', async () => {
    const before = await row();
    meta.appId = '999999999';
    expect((await connect()).status).toBe(400);
    meta.appId = APP_ID;
    meta.targets = ['777777777'];
    const res = await connect({ waba_id: WABA, phone_number_id: PNID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not shared/);
    expect((await row()).updated_at).toEqual(before.updated_at);
  });

  test('a phone number outside the shared account is refused', async () => {
    expect((await connect({ waba_id: WABA, phone_number_id: '555555555' })).body.error).toMatch(/does not belong/);
  });

  test('several numbers and no choice: asks to choose instead of guessing', async () => {
    meta.numbers.push({ id: '555555555', display_phone_number: '+91 90000 00009' });
    expect((await connect()).status).toBe(409);
  });

  test('an expired code is reported, without leaking the app secret', async () => {
    meta.fail['GET oauth/access_token'] = graphError(100, 'This authorization code has expired.');
    const res = await connect();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/expired/);
    expect(JSON.stringify(res.body)).not.toMatch(/test-app-secret/);
  });

  test('only people who may change settings can connect', async () => {
    const agent = await signedIn('agent');
    expect((await agent.post('/api/settings/whatsapp/embedded-signup', { code: 'one-time-code-123', mode: 'new' })).status).toBe(403);
    expect((await agent.del('/api/settings/whatsapp/connection')).status).toBe(403);
  });
});

describe('embedded signup: coexistence', () => {
  beforeEach(() => { Object.assign(meta.numbers[0], { platform_type: 'CLOUD_API', status: 'CONNECTED', is_on_biz_app: true }); });

  test('never registers the number (that would log the phone out) and asks for contacts and history once', async () => {
    const res = await connect({ mode: 'coexistence', waba_id: WABA });
    expect(res.body.account).toMatchObject({ status: 'connected', is_coexistence: true, contacts_sync_status: 'requested', history_sync_status: 'requested' });
    expect(calls('POST', /register$/)).toHaveLength(0);
    expect(calls('POST', /smb_app_data$/).map((r) => r.body.sync_type)).toEqual(['smb_app_state_sync', 'history']);
    mock.requests.length = 0;
    await owner.post('/api/settings/whatsapp/finish-setup', {});
    expect(calls('POST', /smb_app_data$/)).toHaveLength(0);
  });

  test('"new number" picked by mistake for a number in the Business app is still not registered', async () => {
    const res = await connect({ mode: 'new' });
    expect(res.body.account.is_coexistence).toBe(true);
    expect(calls('POST', /register$/)).toHaveLength(0);
  });

  test('a refused import does not stop the number from working, and can be retried', async () => {
    meta.fail[`POST ${PNID}/smb_app_data`] = graphError(100, 'Sync window expired');
    const res = await connect({ mode: 'coexistence' });
    expect(res.body.account).toMatchObject({ status: 'connected', history_sync_status: 'failed', contacts_sync_status: 'failed' });
    meta.fail = {};
    const again = await owner.post('/api/settings/whatsapp/finish-setup', {});
    expect(again.body.account).toMatchObject({ history_sync_status: 'requested', contacts_sync_status: 'requested' });
  });
});

describe('coexistence webhooks', () => {
  const CUST = '919811100001';
  const conv = (phone) => one(
    `SELECT cv.*, ct.name AS contact_name, ct.opted_in FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.phone = $1`, [phone]);

  test('a reply typed on the phone appears in the inbox and the bot steps aside', async () => {
    await postWebhook(inboundText('wamid.CX1', 'Hi, price?', CUST));
    await drain();
    expect((await conv(CUST)).handling_mode).toBe('bot');
    const echo = change('smb_message_echoes', { message_echoes: [{ from: '919392534625', to: CUST, id: 'wamid.ECHO1', timestamp: ts(), type: 'text', text: { body: 'Calling you now' } }] });
    expect((await postWebhook(echo)).status).toBe(200);
    await postWebhook(echo);   // Meta repeats webhooks
    await drain();
    const c = await conv(CUST);
    expect(c).toMatchObject({ handling_mode: 'human', needs_human: false, unread_count: 0, last_message_preview: 'Calling you now', last_message_direction: 'outbound' });
    const { rows } = await pool.query(`SELECT direction, sender_type, status, payload FROM messages WHERE wa_message_id = 'wamid.ECHO1'`);
    expect(rows).toEqual([{ direction: 'outbound', sender_type: 'agent', status: 'sent', payload: { via: 'whatsapp_app' } }]);
    const handover = await one(`SELECT actor_type FROM audit_log WHERE entity_id = $1 AND action = 'conversation.handover' ORDER BY created_at DESC LIMIT 1`, [c.id]);
    expect(handover.actor_type).toBe('system');
  });

  test('address book: fills blank names, keeps strangers out of broadcasts until they write', async () => {
    await pool.query(`UPDATE contacts SET name = 'Staff edited' WHERE phone = $1`, [CUST]);
    await postWebhook(change('smb_app_state_sync', { state_sync: [
      { type: 'contact', action: 'add', contact: { full_name: 'Phone Name', phone_number: CUST }, metadata: { timestamp: ts() } },
      { type: 'contact', action: 'add', contact: { full_name: 'Amma', phone_number: '919811100002' }, metadata: { timestamp: ts() } },
      { type: 'contact', action: 'remove', contact: { phone_number: '919811100003' }, metadata: { timestamp: ts() } },
    ] }));
    await drain();
    expect((await conv(CUST)).contact_name).toBe('Staff edited');
    expect(await one(`SELECT name, opted_in FROM contacts WHERE phone = '919811100002'`)).toEqual({ name: 'Amma', opted_in: false });
    expect(await one(`SELECT 1 FROM contacts WHERE phone = '919811100003'`)).toBeUndefined();
    expect((await row()).contacts_sync_status).toBe('completed');

    await postWebhook(inboundText('wamid.CX2', 'Need balloons', '919811100002', 'Amma'));
    await drain();
    expect(await one(`SELECT opted_in FROM contacts WHERE phone = '919811100002'`)).toEqual({ opted_in: true });
  });

  test('history fills the inbox quietly: no unread, no bot replies, duplicates ignored, progress kept', async () => {
    const P = '919811100004';
    const old = (days) => String(Math.floor(Date.now() / 1000) - days * 86_400);
    const jobsBefore = (await one(`SELECT count(*)::int AS n FROM jobs WHERE name = 'ai_reply'`)).n;
    const body = (progress, messages) => change('history', { history: [{ metadata: { phase: 1, chunk_order: 1, progress }, threads: [{ id: P, context: { wa_id: P }, messages }] }] });
    await postWebhook(body(55, [
      { from: P, id: 'wamid.H1', timestamp: old(10), type: 'text', text: { body: 'Birthday decor?' }, history_context: { status: 'READ' } },
      { from: '919392534625', to: P, id: 'wamid.H2', timestamp: old(9), type: 'text', text: { body: 'Yes, 4999' }, history_context: { status: 'READ' } },
      { from: P, id: 'wamid.H3', timestamp: old(8), type: 'media_placeholder', history_context: { status: 'READ' } },
    ]));
    await drain();
    const c = await conv(P);
    expect(c).toMatchObject({ unread_count: 0, handling_mode: 'bot' });
    expect(Date.now() - new Date(c.last_inbound_at).getTime()).toBeGreaterThan(7 * 86_400_000);   // the 24h window stays closed
    const { rows } = await pool.query(`SELECT wa_message_id, direction, sender_type, status FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [c.id]);
    expect(rows.map((r) => [r.wa_message_id, r.direction, r.sender_type, r.status])).toEqual([
      ['wamid.H1', 'inbound', 'customer', 'received'], ['wamid.H2', 'outbound', 'agent', 'read'], ['wamid.H3', 'inbound', 'customer', 'received']]);
    expect((await one(`SELECT count(*)::int AS n FROM jobs WHERE name = 'ai_reply'`)).n).toBe(jobsBefore);
    expect(await row()).toMatchObject({ history_sync_status: 'syncing', history_sync_progress: 55 });

    // the photo behind the placeholder, then the last chunk, then a late older chunk
    await postWebhook(change('history', { messages: [{ from: P, id: 'wamid.H3', timestamp: old(8), type: 'image', image: { id: 'media-9', mime_type: 'image/jpeg', sha256: 'x' } }] }));
    await postWebhook(body(100, [{ from: P, id: 'wamid.H1', timestamp: old(10), type: 'text', text: { body: 'changed' } }]));
    await drain();
    await postWebhook(body(60, []));
    await drain();
    expect(await one(`SELECT message_type, media_id IS NOT NULL AS has_media FROM messages WHERE wa_message_id = 'wamid.H3'`)).toEqual({ message_type: 'image', has_media: true });
    expect((await one(`SELECT body FROM messages WHERE wa_message_id = 'wamid.H1'`)).body).toBe('Birthday decor?');
    expect(await row()).toMatchObject({ history_sync_status: 'completed', history_sync_progress: 100 });
  });

  test('the owner declined to share history', async () => {
    await postWebhook(change('history', { history: [{ errors: [{ code: 2593109, title: 'History sync is turned off' }] }] }));
    await drain();
    expect((await row()).history_sync_status).toBe('declined');
  });
});

describe('disconnect', () => {
  test('forgets the token, keeps the chats, stops sending and receiving; reconnecting works', async () => {
    meta.numbers.push({ id: '555555555', display_phone_number: '+91 90000 00009' });
    const chats = (await one('SELECT count(*)::int AS n FROM conversations')).n;
    const res = await owner.del('/api/settings/whatsapp/connection');
    expect(res.body.account.status).toBe('disconnected');
    expect(calls('DELETE', /subscribed_apps/)).toHaveLength(0);   // another number shares this account
    expect((await row()).access_token_enc).toBeNull();
    expect((await one('SELECT count(*)::int AS n FROM conversations')).n).toBe(chats);
    expect(await routeByPhoneNumberId(PNID)).toBeNull();
    expect((await owner.post('/api/settings/whatsapp/health')).status).toBe(409);   // must not come back to life with the server token
    expect((await owner.del('/api/settings/whatsapp/connection')).status).toBe(404);

    meta.numbers.pop();
    expect((await connect()).body.account.status).toBe('connected');
    expect(await routeByPhoneNumberId(PNID)).not.toBeNull();
    await owner.del('/api/settings/whatsapp/connection');
    expect(calls('DELETE', /subscribed_apps/)).toHaveLength(1);   // the only number: unsubscribed
  });
});

describe('dashboard on another origin', () => {
  const ORIGIN = 'https://app.balloonsbuzz.test';

  test('preflight from the dashboard passes, with credentials and the CSRF header', async () => {
    const res = await request(app).options('/api/auth/login').set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type,x-requested-with');
    expect(res.status).toBe(204);
    expect(res.headers).toMatchObject({ 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' });
    expect(res.headers['access-control-allow-headers']).toMatch(/X-Requested-With/);
    expect(res.headers['access-control-allow-methods']).toMatch(/PATCH.*DELETE/);
    expect(res.headers.vary).toMatch(/Origin/);
  });

  test('errors are readable too; photos may be embedded by the sibling subdomain', async () => {
    const res = await request(app).get('/api/auth/me').set('Origin', ORIGIN);
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  test.each(['https://evil.example', 'https://app.balloonsbuzz.test.evil.example', 'http://app.balloonsbuzz.test', 'null'])(
    '%s gets no CORS headers', async (origin) => {
      const pre = await request(app).options('/api/auth/login').set('Origin', origin).set('Access-Control-Request-Method', 'POST');
      const get = await request(app).get('/api/auth/me').set('Origin', origin);
      for (const r of [pre, get]) {
        expect(r.headers).not.toHaveProperty('access-control-allow-origin');
        expect(r.headers).not.toHaveProperty('access-control-allow-credentials');
      }
    });

  test('the cron endpoint needs its secret and counts as the worker checking in', async () => {
    expect((await request(app).get('/internal/cron')).status).toBe(401);
    expect((await request(app).get('/internal/cron').set('Authorization', 'Bearer wrong-secret-000000')).status).toBe(401);
    await pool.query('DELETE FROM worker_heartbeats');
    expect((await request(app).get('/internal/cron').set('Authorization', `Bearer ${process.env.CRON_SECRET}`)).status).toBe(200);
    expect((await one('SELECT count(*)::int AS n FROM worker_heartbeats')).n).toBe(1);
    await pool.query('DELETE FROM worker_heartbeats');
  });

  test('without a worker process, the inline queue answers a webhook, including jobs due in a moment', async () => {
    const { drain: inlineDrain } = require('../src/queue/inline');
    const { rows: [t] } = await pool.query(`SELECT id FROM tenants LIMIT 1`);
    const jobs = require('../src/queue/jobs');
    const soon = await jobs.enqueue({ tenantId: t.id, name: 'mark_read', payload: { message_id: '00000000-0000-0000-0000-000000000000' }, delayMs: 600 });
    const later = await jobs.enqueue({ tenantId: t.id, name: 'mark_read', payload: { message_id: '00000000-0000-0000-0000-000000000000' }, delayMs: 3_600_000 });
    await inlineDrain(10_000);
    const status = async (j) => (await one('SELECT status FROM jobs WHERE id = $1', [j.id])).status;
    expect([await status(soon), await status(later)]).toEqual(['done', 'queued']);
    await pool.query('DELETE FROM jobs WHERE id = $1', [later.id]);
  });
});
