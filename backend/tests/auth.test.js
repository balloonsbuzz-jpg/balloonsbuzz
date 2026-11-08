const { app, pool, request, createUser, signedIn, PASSWORD } = require('./helpers');
const logger = require('../src/lib/logger');

afterAll(() => pool.end());

const H = { 'X-Requested-With': 'bb-web' };
const login = (email, password) => request(app).post('/api/auth/login').set(H).send({ email, password });
const cookieMap = (res) => Object.fromEntries((res.headers['set-cookie'] || []).map((c) => [c.split('=')[0], c]));

test('health reports the database', async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok', db: 'ok' });
});

test('wrong password and unknown email give the same generic error', async () => {
  const u = await createUser('agent');
  const a = await login(u.email, 'nope-nope-nope');
  const b = await login('nobody@example.com', 'nope-nope-nope');
  expect(a.status).toBe(401);
  expect(b.status).toBe(401);
  expect(a.body.error).toBe(b.body.error);
});

test('login sets httpOnly SameSite=Strict cookies and /me returns the user without secrets', async () => {
  const u = await createUser('admin');
  const res = await login(u.email, PASSWORD);
  expect(res.status).toBe(200);
  const cookies = cookieMap(res);
  for (const name of ['bb_at', 'bb_rt']) {
    expect(cookies[name]).toMatch(/HttpOnly/i);
    expect(cookies[name]).toMatch(/SameSite=Strict/i);
  }
  expect(cookies.bb_rt).toMatch(/Path=\/api\/auth/);

  const me = await request(app).get('/api/auth/me').set('Cookie', [cookies.bb_at.split(';')[0]]);
  expect(me.status).toBe(200);
  expect(me.body.user).toMatchObject({ email: u.email, role: 'admin' });
  expect(JSON.stringify(me.body)).not.toMatch(/password|hash/i);
});

test('state-changing requests without the CSRF header are refused', async () => {
  const u = await createUser('agent');
  const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(403);
});

test('logout ends the session immediately, even for a still-valid access token', async () => {
  const u = await createUser('agent');
  const at = cookieMap(await login(u.email, PASSWORD)).bb_at.split(';')[0];
  expect((await request(app).get('/api/auth/me').set('Cookie', [at])).status).toBe(200);
  expect((await request(app).post('/api/auth/logout').set(H).set('Cookie', [at])).status).toBe(200);
  expect((await request(app).get('/api/auth/me').set('Cookie', [at])).status).toBe(401);
});

test('refresh rotates the token: the old refresh token stops working', async () => {
  const u = await createUser('agent');
  const res = await login(u.email, PASSWORD);
  const oldRt = cookieMap(res).bb_rt.split(';')[0];
  const r1 = await request(app).post('/api/auth/refresh').set(H).set('Cookie', [oldRt]);
  expect(r1.status).toBe(200);
  const r2 = await request(app).post('/api/auth/refresh').set(H).set('Cookie', [oldRt]);
  expect(r2.status).toBe(401);
});

test('a disabled user is signed out on the next request', async () => {
  const s = await signedIn('agent');
  await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [s.user.id]);
  expect((await s.get('/api/auth/me')).status).toBe(401);
});

test('inactive users cannot log in', async () => {
  const u = await createUser('agent', { is_active: false });
  expect((await login(u.email, PASSWORD)).status).toBe(401);
});

test('login is written to the audit log', async () => {
  const s = await signedIn('admin');
  const { rows } = await pool.query(`SELECT action FROM audit_log WHERE actor_user_id = $1`, [s.user.id]);
  expect(rows.map((r) => r.action)).toContain('auth.login');
});

test('the logger redacts secrets but keeps analytics fields', () => {
  const out = logger.redactForTest({ password: 'x', api_key: 'y', access_token: 'z', nested: { secret: 's' }, input_tokens: 42 });
  expect(out).toMatchObject({ password: '[REDACTED]', api_key: '[REDACTED]', access_token: '[REDACTED]', nested: { secret: '[REDACTED]' }, input_tokens: 42 });
});
