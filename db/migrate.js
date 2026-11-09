#!/usr/bin/env node
/**
 * Minimal SQL migration runner (no ORM), following Whapter's numbered-SQL-file
 * convention but recording what ran in `schema_migrations`.
 *
 *   node db/migrate.js up            apply all pending  *.up.sql
 *   node db/migrate.js down [n|all]  roll back last n (default 1) via *.down.sql
 *   node db/migrate.js status        list applied / pending
 *   node db/migrate.js seed          run db/seeds/*.sql (idempotent)
 *   node db/migrate.js reset         down all, up, seed   (refuses when NODE_ENV=production)
 *
 * Each file runs in its own transaction. An applied file whose checksum changed
 * aborts `up`: write a new migration instead of editing an old one.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const SEEDS_DIR = path.join(__dirname, 'seeds');

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.up\.sql$/.test(f))
    .sort()
    .map((up) => {
      const name = up.replace(/\.up\.sql$/, '');
      const down = `${name}.down.sql`;
      if (!fs.existsSync(path.join(MIGRATIONS_DIR, down))) {
        throw new Error(`Missing down file for ${name}`);
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, up), 'utf8');
      return { name, up, down, sql, checksum: sha256(sql) };
    });
}

function sha256(s) {
  return crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  // Hidden from Supabase's public Data API like every other table (owner bypasses RLS).
  await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
}

async function applied(client) {
  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  return rows;
}

async function inTx(client, fn) {
  await client.query('BEGIN');
  try {
    await fn();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function up(client, log = console.log) {
  await ensureTable(client);
  const done = new Map((await applied(client)).map((r) => [r.name, r.checksum]));
  const all = listMigrations();
  for (const m of all) {
    if (done.has(m.name) && done.get(m.name) !== m.checksum) {
      throw new Error(`Checksum mismatch for applied migration ${m.name}. Create a new migration instead of editing it.`);
    }
  }
  let count = 0;
  for (const m of all.filter((x) => !done.has(x.name))) {
    await inTx(client, async () => {
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
    });
    log(`  ↑ ${m.name}`);
    count++;
  }
  log(count ? `Applied ${count} migration(s).` : 'Nothing to apply.');
  return count;
}

async function down(client, steps = 1, log = console.log) {
  await ensureTable(client);
  const done = (await applied(client)).map((r) => r.name).reverse();
  const target = steps === 'all' ? done : done.slice(0, steps);
  for (const name of target) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${name}.down.sql`), 'utf8');
    await inTx(client, async () => {
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
    });
    log(`  ↓ ${name}`);
  }
  log(`Rolled back ${target.length} migration(s).`);
  return target.length;
}

async function seed(client, log = console.log) {
  const files = fs.readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await inTx(client, () => client.query(fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8')));
    log(`  ✓ seed ${f}`);
  }
  return files.length;
}

async function status(client, log = console.log) {
  await ensureTable(client);
  const done = new Set((await applied(client)).map((r) => r.name));
  for (const m of listMigrations()) log(`${done.has(m.name) ? '[x]' : '[ ]'} ${m.name}`);
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const [cmd = 'status', arg] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: require('./ssl').sslOptions() });
  await client.connect();
  try {
    if (cmd === 'up') await up(client);
    else if (cmd === 'down') await down(client, arg === 'all' ? 'all' : Number(arg || 1));
    else if (cmd === 'status') await status(client);
    else if (cmd === 'seed') await seed(client);
    else if (cmd === 'reset') {
      if (process.env.NODE_ENV === 'production') throw new Error('reset is disabled in production');
      await down(client, 'all');
      await up(client);
      await seed(client);
    } else throw new Error(`Unknown command: ${cmd}`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Migration failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { up, down, seed, status, listMigrations };
