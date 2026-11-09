const http = require('http');
const { app, pool, signedIn } = require('./helpers');
const { startMockGraph } = require('./mock-graph');
const { postWebhook, inboundText, ensureAccount } = require('./wa-helpers');
const { createWorker } = require('../src/queue/worker-loop');
const handlers = require('../src/queue/handlers');
const { canBotReply, matchesHandoverKeyword } = require('../src/conversations/handover.service');
const bus = require('../src/realtime/bus');

let mock, owner, agent, worker;
const drain = () => worker.drain({ timeoutMs: 30_000 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
let seq = 0;
const phoneN = () => `9198770${String(Date.now()).slice(-4)}${String(++seq).padStart(2, '0')}`.slice(0, 12);

/** Simulate a customer message and return its conversation id. */
async function customerSays(text, phone, name = 'Customer') {
  await postWebhook(inboundText(`wamid.INBOX${Date.now()}${++seq}`, text, phone, name));
  await drain();
  return (await one(`SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.phone = $1`, [phone])).id;
}

beforeAll(async () => {
  mock = await startMockGraph(Number(process.env.GRAPH_MOCK_PORT));
  owner = await signedIn('owner');
  agent = await signedIn('agent');
  await ensureAccount(owner);
  worker = createWorker({ handlers, concurrency: 4, pollMs: 50 });
});
afterAll(async () => { await bus.stop(); await mock.close(); await pool.end(); });
beforeEach(() => mock.reset());

describe('inbox list', () => {
  test('a new customer shows up as unread in the inbox with a preview and an open 24h window', async () => {
    const phone = phoneN();
    const id = await customerSays('Hi, need balloon decor for my son’s 5th birthday', phone, 'Kavya');
    const res = await agent.get('/api/conversations?filter=unread');
    const row = res.body.conversations.find((c) => c.id === id);
    expect(row).toMatchObject({ contact_name: 'Kavya', contact_phone: phone, unread_count: 1, handling_mode: 'bot', window_open: true,
      last_message_preview: 'Hi, need balloon decor for my son’s 5th birthday', last_message_direction: 'inbound' });
    const counts = await agent.get('/api/conversations/counts');
    expect(counts.body.unread).toBeGreaterThanOrEqual(1);
  });

  test('search finds by name or by phone digits; paging uses a cursor', async () => {
    const phone = phoneN();
    await customerSays('hello', phone, 'Zubeda Searchable');
    expect((await agent.get('/api/conversations?search=zubeda')).body.conversations.map((c) => c.contact_phone)).toContain(phone);
    expect((await agent.get(`/api/conversations?search=${phone.slice(-6)}`)).body.conversations.map((c) => c.contact_phone)).toContain(phone);
    const page1 = await agent.get('/api/conversations?limit=1');
    expect(page1.body.conversations).toHaveLength(1);
    expect(page1.body.next_cursor).toBeTruthy();
    const page2 = await agent.get(`/api/conversations?limit=1&cursor=${encodeURIComponent(page1.body.next_cursor)}`);
    expect(page2.body.conversations[0].id).not.toBe(page1.body.conversations[0].id);
  });

  test('marking read clears unread and sends WhatsApp blue ticks', async () => {
    const id = await customerSays('Are you open today?', phoneN());
    expect((await agent.post(`/api/conversations/${id}/read`)).status).toBe(200);
    await drain();
    expect((await one(`SELECT unread_count FROM conversations WHERE id = $1`, [id])).unread_count).toBe(0);
    expect(mock.requests.some((r) => r.body?.status === 'read' && /^wamid\.INBOX/.test(r.body.message_id))).toBe(true);
  });
});

describe('agent replies and notes', () => {
  test('an agent reply takes the chat over from the bot, assigns it, and is sent', async () => {
    const id = await customerSays('Can you do it for 4000?', phoneN());
    const res = await agent.post(`/api/conversations/${id}/messages`, { text: 'Hi! This is Sneha from BalloonsBuzz 😊' });
    expect(res.status).toBe(202);
    await drain();
    const cv = await one(`SELECT handling_mode, needs_human, assigned_user_id FROM conversations WHERE id = $1`, [id]);
    expect(cv).toEqual({ handling_mode: 'human', needs_human: false, assigned_user_id: agent.user.id });
    const ev = await one(`SELECT from_mode, to_mode, trigger, actor_user_id FROM handover_events WHERE conversation_id = $1`, [id]);
    expect(ev).toEqual({ from_mode: 'bot', to_mode: 'human', trigger: 'agent_reply', actor_user_id: agent.user.id });
    const msgs = (await agent.get(`/api/conversations/${id}/messages`)).body.messages;
    const mine = msgs.find((m) => m.direction === 'outbound');
    expect(mine).toMatchObject({ sender_type: 'agent', sender_name: 'Test agent', status: 'sent', body: 'Hi! This is Sneha from BalloonsBuzz 😊' });
    expect(mine.payload).toEqual({ send_type: 'text' });   // internal send payload not exposed
    expect((await canBotReply(id)).allowed).toBe(false);
  });

  test('internal notes are stored but never sent to WhatsApp', async () => {
    const id = await customerSays('ok', phoneN());
    const res = await agent.post(`/api/conversations/${id}/messages`, { text: 'Customer prefers pastel colours', as_note: true });
    expect(res.status).toBe(201);
    await drain();
    expect(mock.requests.some((r) => JSON.stringify(r.body || {}).includes('pastel'))).toBe(false);
    const note = (await agent.get(`/api/conversations/${id}/messages`)).body.messages.find((m) => m.is_internal_note);
    expect(note.body).toBe('Customer prefers pastel colours');
    expect((await one(`SELECT handling_mode FROM conversations WHERE id = $1`, [id])).handling_mode).toBe('bot');  // a note doesn't take over
  });

  test('replies are refused once the 24h window has closed', async () => {
    const id = await customerSays('hi', phoneN());
    await pool.query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [id]);
    const res = await agent.post(`/api/conversations/${id}/messages`, { text: 'Still interested?' });
    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe('outside_24h_window');
    // and the failed attempt did not silently take the chat over
    expect((await one(`SELECT handling_mode FROM conversations WHERE id = $1`, [id])).handling_mode).toBe('bot');
  });
});

describe('handover controls', () => {
  test('take over -> pause with timer -> auto resume, each recorded and audited', async () => {
    const id = await customerSays('need help choosing', phoneN());
    expect((await agent.post(`/api/conversations/${id}/takeover`, {})).body.conversation.handling_mode).toBe('human');
    expect((await canBotReply(id))).toEqual({ allowed: false, reason: 'handling_mode_human' });

    const p = await agent.post(`/api/conversations/${id}/pause`, { resume_in_minutes: 30 });
    expect(p.body.conversation.handling_mode).toBe('paused');
    const job = await one(`SELECT id, run_at > now() + interval '29 minutes' AS later FROM jobs WHERE name = 'auto_resume' AND payload->>'conversation_id' = $1`, [id]);
    expect(job.later).toBe(true);

    // time passes
    await pool.query(`UPDATE conversations SET bot_resume_at = now() WHERE id = $1`, [id]);
    await pool.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
    await drain();
    expect((await one(`SELECT handling_mode, bot_resume_at FROM conversations WHERE id = $1`, [id]))).toEqual({ handling_mode: 'bot', bot_resume_at: null });
    expect((await canBotReply(id)).allowed).toBe(true);

    const trail = (await pool.query(`SELECT trigger FROM handover_events WHERE conversation_id = $1 ORDER BY created_at`, [id])).rows.map((r) => r.trigger);
    expect(trail).toEqual(['agent_takeover', 'agent_pause', 'auto_resume']);
    const audits = await one(`SELECT count(*)::int n FROM audit_log WHERE action = 'conversation.handover' AND entity_id = $1`, [id]);
    expect(audits.n).toBe(3);
  });

  test('a stale resume timer does nothing if an agent resumed and re-took the chat since', async () => {
    const id = await customerSays('hello', phoneN());
    await agent.post(`/api/conversations/${id}/pause`, { resume_in_minutes: 10 });
    await agent.post(`/api/conversations/${id}/resume`, {});
    await agent.post(`/api/conversations/${id}/takeover`, {});
    await pool.query(`UPDATE jobs SET run_at = now() WHERE name = 'auto_resume' AND payload->>'conversation_id' = $1`, [id]);
    await drain();
    expect((await one(`SELECT handling_mode FROM conversations WHERE id = $1`, [id])).handling_mode).toBe('human');
  });

  test('turning the bot off globally also blocks replies', async () => {
    const id = await customerSays('hi', phoneN());
    await pool.query(`UPDATE ai_agent_config SET is_enabled = false`);
    try {
      expect(await canBotReply(id)).toEqual({ allowed: false, reason: 'bot_disabled' });
    } finally {
      await pool.query(`UPDATE ai_agent_config SET is_enabled = true`);
    }
  });
});

describe('keyword handover', () => {
  test('"talk to a human" pauses the bot, flags the chat for the team and tells the customer', async () => {
    const id = await customerSays('Can I talk to a human please?', phoneN());
    await drain();
    const cv = await one(`SELECT handling_mode, needs_human, handover_reason FROM conversations WHERE id = $1`, [id]);
    expect(cv).toMatchObject({ handling_mode: 'human', needs_human: true });
    expect(cv.handover_reason).toMatch(/human/);
    const sys = await one(`SELECT sender_type, body, status FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`, [id]);
    expect(sys).toMatchObject({ sender_type: 'system', status: 'sent' });
    expect(sys.body).toMatch(/Connecting you with our team/);
    expect((await agent.get('/api/conversations?filter=needs_human')).body.conversations.map((c) => c.id)).toContain(id);
  });

  test('normal sales questions do not trigger a handover', async () => {
    const id = await customerSays("What's the price per person for a baby shower?", phoneN());
    expect((await one(`SELECT handling_mode FROM conversations WHERE id = $1`, [id])).handling_mode).toBe('bot');
  });

  test('keyword matching is whole-phrase and case-insensitive', () => {
    const kw = ['human', 'call me', 'talk to a person'];
    expect(matchesHandoverKeyword('CALL ME back pls', kw)).toBe('call me');
    expect(matchesHandoverKeyword('I want to talk to a person.', kw)).toBe('talk to a person');
    expect(matchesHandoverKeyword('humanity themed decor?', kw)).toBeNull();
    expect(matchesHandoverKeyword('', kw)).toBeNull();
  });
});

describe('live updates (SSE)', () => {
  test('a new customer message is pushed to signed-in dashboards of the same business', async () => {
    await bus.start();
    const server = app.listen(0);
    const { port } = server.address();
    const cookie = (await owner.agent.jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false }))
      .map((c) => c.toValueString()).join('; ');
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Cookie: cookie } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { for (const m of chunk.matchAll(/event: ([\w.]+)\ndata: (.*)\n/g)) events.push({ type: m[1], data: JSON.parse(m[2]) }); });
    });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const id = await customerSays('live update test', phoneN());
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !events.some((e) => e.type === 'message.new' && e.data.conversation_id === id)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(events.some((e) => e.type === 'message.new' && e.data.conversation_id === id)).toBe(true);
      expect(JSON.stringify(events)).not.toContain('live update test');   // ids only, never message text
      expect(JSON.stringify(events)).not.toContain('tenantId');
    } finally {
      req.destroy();
      server.close();
    }
  });
});
