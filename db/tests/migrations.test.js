// Migration runner + schema-wide conventions (indexes, timestamps, tenant scoping).
const { createTestDb, quiet } = require('./helpers');
const { up, down, seed, listMigrations } = require('../migrate');

let db;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.drop(); });

const tablesQuery = `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'
  ORDER BY 1`;

test('up applies every migration on an empty database, and a re-run applies none', async () => {
  const applied = await up(db.client, quiet);
  expect(applied).toBe(listMigrations().length);
  expect(await up(db.client, quiet)).toBe(0);
});

test('seed runs twice without changing row counts (idempotent)', async () => {
  await seed(db.client, quiet);
  const count = async () => (await db.client.query(`
    SELECT (SELECT count(*) FROM packages) p, (SELECT count(*) FROM themes) t,
           (SELECT count(*) FROM theme_aliases) a, (SELECT count(*) FROM pricing_rules) r,
           (SELECT count(*) FROM distance_slabs) s, (SELECT count(*) FROM roles) ro`)).rows[0];
  const first = await count();
  await seed(db.client, quiet);
  expect(await count()).toEqual(first);
  expect(Number(first.p)).toBeGreaterThanOrEqual(20);
  expect(Number(first.ro)).toBe(3);
});

test('every foreign key column is the leading column of some index', async () => {
  const { rows } = await db.client.query(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      AND NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
    ORDER BY 1, 2`);
  expect(rows).toEqual([]);
});

test('every table has created_at (timestamptz) and mutable tables keep updated_at via trigger', async () => {
  const { rows: missingCreated } = await db.client.query(`
    SELECT t.table_name FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND t.table_name <> 'schema_migrations'
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_name = t.table_name AND c.column_name = 'created_at'
                        AND c.data_type = 'timestamp with time zone')`);
  expect(missingCreated).toEqual([]);

  const { rows: missingTrigger } = await db.client.query(`
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
      AND NOT EXISTS (SELECT 1 FROM pg_trigger tg
                      WHERE tg.tgrelid = c.table_name::regclass AND NOT tg.tgisinternal
                        AND tg.tgfoid = 'update_updated_at_column'::regproc)`);
  expect(missingTrigger).toEqual([]);
});

test('every business table except tenants and join tables is tenant-scoped', async () => {
  const { rows } = await db.client.query(`
    SELECT t.table_name FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      -- worker_heartbeats: one worker serves every tenant (system table, like schema_migrations)
      AND t.table_name NOT IN ('schema_migrations', 'tenants', 'worker_heartbeats')
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_name = t.table_name AND c.column_name = 'tenant_id')`);
  expect(rows).toEqual([]);
});

test('hot-path indexes exist: phone, conversation status, created_at on high-volume tables', async () => {
  const { rows } = await db.client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
  const names = new Set(rows.map((r) => r.indexname));
  for (const idx of [
    'idx_contacts_phone', 'uq_contacts_tenant_phone', 'idx_conversations_status', 'idx_conversations_handling_mode',
    'idx_conversations_needs_human', 'uq_messages_tenant_wa_message_id', 'idx_messages_conversation_created',
    'idx_messages_created_at', 'idx_conversations_created_at', 'idx_contacts_created_at', 'idx_leads_created_at',
    'idx_bookings_created_at', 'idx_webhook_events_created_at', 'idx_audit_log_created_at', 'idx_ai_runs_created_at',
    'idx_gallery_items_sendable_theme', 'idx_gallery_items_sendable_price', 'idx_broadcast_recipients_phone',
  ]) expect(names).toContain(idx);
});

test('every table has row-level security on (locks out Supabase Data API roles)', async () => {
  const { rows } = await db.client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
  expect(rows).toEqual([]);
});

test('down all removes every table, and up rebuilds cleanly', async () => {
  await down(db.client, 'all', quiet);
  expect((await db.client.query(tablesQuery)).rows).toEqual([]);
  expect(await up(db.client, quiet)).toBe(listMigrations().length);
  await seed(db.client, quiet);
});

test('editing an already-applied migration is detected', async () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'migrations', listMigrations()[0].up);
  const original = fs.readFileSync(file, 'utf8');
  try {
    fs.writeFileSync(file, original + '\n-- tampered\n');
    await expect(up(db.client, quiet)).rejects.toThrow(/Checksum mismatch/);
  } finally {
    fs.writeFileSync(file, original);
  }
});
