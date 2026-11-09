// Creates an isolated throwaway database per test file and tears it down after.
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { sslOptions } = require('../ssl');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ADMIN_URL = process.env.DATABASE_URL_TEST_ADMIN;

async function createTestDb() {
  if (!ADMIN_URL) throw new Error('DATABASE_URL_TEST_ADMIN is not set (see .env.example)');
  const name = `bb_test_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL, ssl: sslOptions() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString(), ssl: sslOptions() });
  await client.connect();

  async function drop() {
    await client.end();
    const a = new Client({ connectionString: ADMIN_URL, ssl: sslOptions() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  }
  return { client, name, drop };
}

const quiet = () => {};

/** Expect a query to fail with a given Postgres error code (23514 check, 23505 unique, 23P01 exclusion...). */
async function expectPgError(promise, code) {
  let err;
  try { await promise; } catch (e) { err = e; }
  if (!err) throw new Error(`Expected Postgres error ${code}, but the query succeeded`);
  if (err.code !== code) throw new Error(`Expected Postgres error ${code}, got ${err.code}: ${err.message}`);
  return err;
}

/** Run fn inside a transaction that is always rolled back (keeps tests independent). */
async function rollback(client, fn) {
  await client.query('BEGIN');
  try { return await fn(); } finally { await client.query('ROLLBACK'); }
}

/** SAVEPOINT wrapper so an expected error doesn't abort the surrounding transaction. */
async function sp(client, fn) {
  await client.query('SAVEPOINT sp');
  try {
    const r = await fn();
    await client.query('RELEASE SAVEPOINT sp');
    return r;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp');
    throw e;
  }
}

async function one(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0];
}

/** Minimal graph: tenant(seeded) -> wa account -> contact -> conversation. */
async function baseFixture(client) {
  const t = await one(client, `SELECT id FROM tenants WHERE slug = 'balloonsbuzz'`);
  const wa = await one(client,
    `INSERT INTO whatsapp_accounts (tenant_id, display_phone, phone_number_id, waba_id, status)
     VALUES ($1, '919392534625', 'PNID_TEST', 'WABA_TEST', 'connected') RETURNING id`, [t.id]);
  const contact = await one(client,
    `INSERT INTO contacts (tenant_id, phone, name) VALUES ($1, '919876543210', 'Test Customer') RETURNING id`, [t.id]);
  const conv = await one(client,
    `INSERT INTO conversations (tenant_id, contact_id, whatsapp_account_id) VALUES ($1, $2, $3) RETURNING id`,
    [t.id, contact.id, wa.id]);
  const pkg = await one(client, `SELECT id FROM packages WHERE tenant_id = $1 AND key = 'two_frames'`, [t.id]);
  return { tenantId: t.id, waId: wa.id, contactId: contact.id, convId: conv.id, packageId: pkg.id };
}

module.exports = { createTestDb, expectPgError, rollback, sp, one, baseFixture, quiet };
