const request = require('supertest');
const { createApp } = require('../src/create-app');
const { pool } = require('../src/db/pool');
const { hashPassword } = require('../src/services/auth.service');

const app = createApp();
const PASSWORD = 'correct-horse-battery-staple';
let counter = 0;

async function createUser(roleKey = 'owner', overrides = {}) {
  counter += 1;
  const email = overrides.email || `${roleKey}${counter}-${Date.now()}@example.com`;
  const { rows } = await pool.query(
    `INSERT INTO users (tenant_id, role_id, full_name, email, password_hash, is_active)
     SELECT t.id, r.id, $2, $3, $4, $5 FROM tenants t JOIN roles r ON r.tenant_id = t.id AND r.key = $1
      WHERE t.slug = 'balloonsbuzz' RETURNING id, tenant_id`,
    [roleKey, overrides.name || `Test ${roleKey}`, email, await hashPassword(PASSWORD), overrides.is_active ?? true]);
  return { ...rows[0], email };
}

/** A supertest agent (keeps cookies) that is signed in and sends the CSRF header. */
async function signedIn(roleKey = 'owner') {
  const user = await createUser(roleKey);
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'bb-web').send({ email: user.email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const h = { 'X-Requested-With': 'bb-web' };
  return {
    user, agent,
    get: (url) => agent.get(url),
    post: (url, body) => agent.post(url).set(h).send(body),
    patch: (url, body) => agent.patch(url).set(h).send(body),
    put: (url, body) => agent.put(url).set(h).send(body),
    del: (url) => agent.delete(url).set(h),
  };
}

module.exports = { app, pool, request, createUser, signedIn, PASSWORD };
