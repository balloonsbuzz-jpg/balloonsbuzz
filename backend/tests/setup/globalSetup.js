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
  // The bot stays off unless a test turns it on, so suites that simulate customers
  // never reach a model. Agent tests point it at the mock LLM (LLM_MOCK_PORT).
  await client.query(`UPDATE ai_agent_config SET is_enabled = false`);
  await client.end();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    DEEPSEEK_API_KEY: 'sk-test-env-key-0000',
    // WhatsApp: point the Graph client at the per-test-file mock server
    META_APP_ID: '123456789012',
    META_SIGNUP_CONFIG_ID: '210987654321',
    CRON_SECRET: 'test-cron-secret-123456',
    FRONTEND_URL: 'https://app.balloonsbuzz.test',
    CORS_ORIGINS: '',
    META_APP_SECRET: 'test-app-secret-123',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify-token-123',
    WHATSAPP_ACCESS_TOKEN: 'EAAtest-env-token',
    GRAPH_MOCK_PORT: '47811',
    META_GRAPH_BASE_URL: 'http://127.0.0.1:47811',
    GRAPH_TIMEOUT_MS: '2000',
    PUBLIC_BASE_URL: 'https://wa.example.test',
    // Gallery: photos on local disk in a temp folder; Drive API is a mock server
    GALLERY_STORAGE: 'local',
    GALLERY_LOCAL_DIR: path.join(os.tmpdir(), `bb-gallery-test-${name}`),
    GDRIVE_API_KEY: 'test-drive-api-key-000000',
    GDRIVE_FOLDER_ID: 'ROOTFOLDER0001',
    DRIVE_MOCK_PORT: '47812',
    GDRIVE_API_BASE: 'http://127.0.0.1:47812/drive/v3',
    GDRIVE_SYNC_INTERVAL_MIN: '0',
    AI_DEBOUNCE_MS: '0',
    LLM_MOCK_PORT: '47813',
  });
  delete process.env.GOOGLE_MAPS_API_KEY;   // distance tests use the straight-line estimate
  fs.writeFileSync(path.join(os.tmpdir(), 'bb-api-test-db.json'), JSON.stringify({ adminUrl, name }));
};
