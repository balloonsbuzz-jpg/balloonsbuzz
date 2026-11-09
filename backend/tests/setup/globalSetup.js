// Creates one migrated + seeded throwaway database for the backend test run.
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { Client } = require('pg');

module.exports = async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
  const adminUrl = process.env.DATABASE_URL_TEST_ADMIN;
  if (!adminUrl) throw new Error('DATABASE_URL_TEST_ADMIN is not set (see .env.example)');

  const name = `bb_api_test_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl, ssl: require('../../../db/ssl').sslOptions() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString(), ssl: require('../../../db/ssl').sslOptions() });
  await client.connect();
  const { up, seed } = require('../../../db/migrate');
  await up(client, () => {});
  await seed(client, () => {});
  await client.end();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    DEEPSEEK_API_KEY: 'sk-test-env-key-0000',
    // WhatsApp: point the Graph client at the per-test-file mock server
    META_APP_SECRET: 'test-app-secret-123',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify-token-123',
    WHATSAPP_ACCESS_TOKEN: 'EAAtest-env-token',
    GRAPH_MOCK_PORT: '47811',
    META_GRAPH_BASE_URL: 'http://127.0.0.1:47811',
    GRAPH_TIMEOUT_MS: '2000',
    PUBLIC_BASE_URL: 'https://wa.example.test',
  });
  fs.writeFileSync(path.join(os.tmpdir(), 'bb-api-test-db.json'), JSON.stringify({ adminUrl, name }));
};
