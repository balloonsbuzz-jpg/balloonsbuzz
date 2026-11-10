// M10: rate limits, health/heartbeat, production config guards.
const { pool, request } = require('./helpers');
const { createApp } = require('../src/app');
const health = require('../src/services/health.service');
const { load, productionProblems } = require('../src/config/env');

afterAll(() => pool.end());

describe('rate limits', () => {
  test('the API answers 429 past the per-IP ceiling; health checks are never limited', async () => {
    const app = createApp({ apiPerMin: 10 });
    const statuses = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await request(app).get('/api/auth/me')).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    const limited = await request(app).get('/api/auth/me');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/Too many requests/);
    expect(limited.headers).toHaveProperty('ratelimit-policy');
    for (let i = 0; i < 3; i += 1) expect((await request(app).get('/api/health')).status).toBe(200);
  });
});

describe('health and worker heartbeat', () => {
  beforeEach(() => pool.query('DELETE FROM worker_heartbeats'));

  test('no worker yet → reported as missing (fatal only in production)', async () => {
    const r = await health.check();
    expect(r.body.worker).toBe('missing');
    expect(r.httpStatus).toBe(200);
  });

  test('a fresh heartbeat is ok; an old one is stale', async () => {
    await health.beat({ concurrency: 4 });
    expect((await health.check()).body.worker).toBe('ok');
    await pool.query(`UPDATE worker_heartbeats SET beat_at = now() - interval '10 minutes'`);
    expect((await health.check()).body.worker).toBe('stale');
    await health.stopBeating();
    expect((await pool.query('SELECT count(*)::int AS n FROM worker_heartbeats')).rows[0].n).toBe(0);
  });

  test('jobs waiting more than 5 minutes show as a backlog', async () => {
    const { rows: [j] } = await pool.query(
      `INSERT INTO jobs (name, payload, run_at) VALUES ('noop_health_test', '{}', now() - interval '10 minutes') RETURNING id`);
    try {
      expect((await health.check()).body).toMatchObject({ queue: 'backlog', status: 'busy' });
    } finally {
      await pool.query('DELETE FROM jobs WHERE id = $1', [j.id]);
    }
  });
});

describe('production configuration guards', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@db.example.com:5432/x',
    JWT_SECRET: 'a'.repeat(40) + 'Zx9',
    ENCRYPTION_KEY: 'ab'.repeat(32),
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.balloonsbuzz.com',
    PUBLIC_BASE_URL: 'https://app.balloonsbuzz.com',
  };

  test('a correct production setup loads, with secure cookies on by default', () => {
    const env = load(base);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.TRUST_PROXY).toBe(0);
  });

  test('unsafe settings stop the app from booting, each named', () => {
    expect(() => load({ ...base, FRONTEND_URL: 'http://app.balloonsbuzz.com', COOKIE_SECURE: 'false' }))
      .toThrow(/COOKIE_SECURE must be true[\s\S]*FRONTEND_URL must be the https/);
    expect(() => load({ ...base, ENCRYPTION_KEY: undefined })).toThrow(/ENCRYPTION_KEY is required/);
    expect(() => load({ ...base, GALLERY_STORAGE: 'local' })).toThrow(/development only/);
    expect(productionProblems({ ...load(base), JWT_SECRET: 'change-me-change-me-change-me-change-me' })[0]).toMatch(/placeholder/);
  });

  test('TRUST_PROXY accepts true/false or a hop count', () => {
    expect(load({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(1);
    expect(load({ ...base, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(load({ ...base, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(0);
    expect(() => load({ ...base, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });
});
