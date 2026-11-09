const { Pool } = require('pg');
const { env } = require('../config/env');
const logger = require('../lib/logger');

const { sslOptions } = require('../../../db/ssl');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: sslOptions(),
  max: env.PGPOOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on('error', (err) => logger.error('pg pool error', { error: err.message }));

/**
 * Run fn(client) in a transaction. `actor` feeds DB triggers that record who
 * did something (e.g. booking_status_history) via SET LOCAL bb.actor_*.
 */
async function withTx(fn, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (actor) {
      await client.query(`SELECT set_config('bb.actor_type', $1, true), set_config('bb.actor_user_id', $2, true)`,
        [actor.type, actor.userId || '']);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query: (text, params) => pool.query(text, params), withTx };
