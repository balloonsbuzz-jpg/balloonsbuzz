// Cross-process realtime events over Postgres LISTEN/NOTIFY (no Redis).
// publish() works from the API and the worker; inside a transaction the event is
// delivered only on COMMIT. The API keeps one LISTEN connection and fans events out
// to Server-Sent-Event clients.
const { EventEmitter } = require('events');
const { Client } = require('pg');
const { env } = require('../config/env');
const { pool } = require('../db/pool');
const logger = require('../lib/logger');
const { sslOptions } = require('../../../db/ssl');

const CHANNEL = 'bb_events';
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/**
 * @param {{tenantId:string, type:string, [k:string]:any}} event  keep it small (ids only): NOTIFY payload max ~8KB
 * @param {object} [db] pg client to publish inside a transaction
 */
async function publish(event, db = pool) {
  const payload = JSON.stringify({ ...event, at: Date.now() });
  try {
    await db.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
  } catch (err) {
    // Realtime is best-effort: never fail the business operation because of it.
    logger.warn('realtime publish failed', { type: event.type, error: err.message });
  }
}

let client = null;
let stopping = false;
let retryMs = 1000;

async function connect() {
  if (client || stopping) return;
  const c = new Client({ connectionString: env.DATABASE_URL, ssl: sslOptions() });
  c.on('notification', (msg) => {
    if (msg.channel !== CHANNEL) return;
    try { emitter.emit('event', JSON.parse(msg.payload)); } catch { /* ignore malformed */ }
  });
  c.on('error', (err) => {
    logger.warn('realtime listener error', { error: err.message });
    reconnect(c);
  });
  c.on('end', () => reconnect(c));
  try {
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    client = c;
    retryMs = 1000;
    emitter.emit('ready');
  } catch (err) {
    logger.warn('realtime listener connect failed', { error: err.message, retryInMs: retryMs });
    reconnect(c);
  }
}

function reconnect(c) {
  if (client === c) client = null;
  c.removeAllListeners('end');
  c.end().catch(() => {});
  if (stopping) return;
  setTimeout(connect, retryMs).unref();
  retryMs = Math.min(retryMs * 2, 30_000);
}

/** Start listening (idempotent). Resolves once LISTEN is active. */
function start() {
  if (client) return Promise.resolve();
  const ready = new Promise((resolve) => emitter.once('ready', resolve));
  connect();
  return ready;
}

async function stop() {
  stopping = true;
  if (client) { const c = client; client = null; c.removeAllListeners('end'); await c.end().catch(() => {}); }
}

/** Subscribe to one tenant's events. Returns an unsubscribe function. */
function subscribe(tenantId, fn) {
  const handler = (e) => { if (e.tenantId === tenantId) fn(e); };
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}

module.exports = { publish, start, stop, subscribe, CHANNEL };
