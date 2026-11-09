// Business rules the DATABASE enforces (defence in depth behind the services).
const { createTestDb, expectPgError, rollback, sp, one, baseFixture, quiet } = require('./helpers');
const { up, seed } = require('../migrate');

let db, c;
beforeAll(async () => {
  db = await createTestDb();
  c = db.client;
  await up(c, quiet);
  await seed(c, quiet);
});
afterAll(async () => { await db.drop(); });

describe('idempotency', () => {
  test('the same WhatsApp message id cannot be stored twice', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const ins = () => c.query(
      `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, message_type, body, wa_message_id, status)
       VALUES ($1,$2,$3,'inbound','customer','text','hi','wamid.ABC','received')`, [f.tenantId, f.convId, f.contactId]);
    await ins();
    await expectPgError(sp(c, ins), '23505');
  }));

  test('a replayed webhook event is ignored via ON CONFLICT', () => rollback(c, async () => {
    const ins = () => c.query(
      `INSERT INTO webhook_events (event_key, event_type, payload, signature_valid)
       VALUES ('msg:wamid.XYZ', 'message', '{}', true) ON CONFLICT (source, event_key) DO NOTHING RETURNING id`);
    expect((await ins()).rowCount).toBe(1);
    expect((await ins()).rowCount).toBe(0);
  }));

  test('a follow-up with the same idempotency key cannot be scheduled twice', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const ins = () => c.query(
      `INSERT INTO followups (tenant_id, contact_id, kind, idempotency_key, scheduled_at, content)
       VALUES ($1,$2,'event_reminder','event_reminder:b1', now(), '{"type":"text","text":"hi"}')`, [f.tenantId, f.contactId]);
    await ins();
    await expectPgError(sp(c, ins), '23505');
  }));
});

describe('handover state', () => {
  test('human/paused mode requires handover_at', () => rollback(c, async () => {
    const f = await baseFixture(c);
    await expectPgError(sp(c, () => c.query(
      `UPDATE conversations SET handling_mode = 'human' WHERE id = $1`, [f.convId])), '23514');
    await c.query(`UPDATE conversations SET handling_mode = 'human', handover_at = now(), needs_human = true WHERE id = $1`, [f.convId]);
  }));

  test('handover_events rejects a no-op switch and unknown triggers', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const ins = (from, to, trig) => c.query(
      `INSERT INTO handover_events (tenant_id, conversation_id, from_mode, to_mode, trigger) VALUES ($1,$2,$3,$4,$5)`,
      [f.tenantId, f.convId, from, to, trig]);
    await ins('bot', 'human', 'discount_limit');
    await expectPgError(sp(c, () => ins('bot', 'bot', 'system')), '23514');
    await expectPgError(sp(c, () => ins('bot', 'human', 'whatever')), '23514');
  }));
});

describe('negotiation limit (DB side)', () => {
  async function lead(f) {
    return one(c, `INSERT INTO leads (tenant_id, contact_id, conversation_id) VALUES ($1,$2,$3) RETURNING id`,
      [f.tenantId, f.contactId, f.convId]);
  }

  test('a quote can never be priced below its floor, and its arithmetic must add up', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const l = await lead(f);
    const q = (final, discount, floor) => c.query(
      `INSERT INTO quotes (tenant_id, lead_id, package_id, list_price, distance_charge, discount_amount, final_price, floor_price)
       VALUES ($1,$2,$3,10000,300,$5,$4,$6)`, [f.tenantId, l.id, f.packageId, final, discount, floor]);
    await q(9300, 1000, 9300);                                   // exactly at floor: ok
    await expectPgError(sp(c, () => q(9200, 1100, 9300)), '23514');  // below floor
    await expectPgError(sp(c, () => q(9000, 1000, 9000)), '23514');  // 10000+300-1000 != 9000
  }));

  test('a booking cannot be agreed below its floor price', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const ins = (agreed) => c.query(
      `INSERT INTO bookings (tenant_id, contact_id, package_id, event_date, venue_address, quoted_price, agreed_price, floor_price)
       VALUES ($1,$2,$3,'2026-12-20','Kondapur',12000,$4,10800)`, [f.tenantId, f.contactId, f.packageId, agreed]);
    await ins(10800);
    await expectPgError(sp(c, () => ins(10500)), '23514');
  }));

  test('negotiation rules must target what their scope says and carry a limit', () => rollback(c, async () => {
    const f = await baseFixture(c);
    await expectPgError(sp(c, () => c.query(
      `INSERT INTO negotiation_rules (tenant_id, scope, max_discount_pct) VALUES ($1,'package',10)`, [f.tenantId])), '23514');
    await expectPgError(sp(c, () => c.query(
      `INSERT INTO negotiation_rules (tenant_id, scope, package_id) VALUES ($1,'package',$2)`, [f.tenantId, f.packageId])), '23514');
    await expectPgError(sp(c, () => c.query(
      `INSERT INTO negotiation_rules (tenant_id, scope, max_discount_pct) VALUES ($1,'global',150)`, [f.tenantId])), '23514');
    await c.query(`INSERT INTO negotiation_rules (tenant_id, scope, package_id, max_discount_amount) VALUES ($1,'package',$2,1500)`,
      [f.tenantId, f.packageId]);
  }));
});

describe('distance slabs', () => {
  test('overlapping active slabs are rejected', () => rollback(c, async () => {
    const f = await baseFixture(c);   // seeded slabs: [0,5) [5,10) [10,20) [20,35) [35,∞)
    await expectPgError(sp(c, () => c.query(
      `INSERT INTO distance_slabs (tenant_id, min_km, max_km, charge_type, amount) VALUES ($1, 8, 12, 'flat', 400)`,
      [f.tenantId])), '23P01');
    // inactive slabs may overlap (drafts)
    await c.query(`INSERT INTO distance_slabs (tenant_id, min_km, max_km, charge_type, amount, is_active)
                   VALUES ($1, 8, 12, 'flat', 400, false)`, [f.tenantId]);
  }));

  test('a slab lookup at a boundary picks exactly one band ([min, max))', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const at = async (km) => (await c.query(
      `SELECT label FROM distance_slabs WHERE tenant_id = $1 AND is_active
         AND numrange(min_km, max_km, '[)') @> $2::numeric`, [f.tenantId, km])).rows.map((r) => r.label);
    expect(await at(5)).toEqual(['5-10 km']);
    expect(await at(4.99)).toEqual(['Within 5 km - free']);
    expect(await at(500)).toHaveLength(1);
  }));
});

describe('bookings & payments', () => {
  test('payments keep advance_paid_amount, advance_status and balance in sync; status changes are logged', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const b = await one(c,
      `INSERT INTO bookings (tenant_id, contact_id, package_id, event_date, venue_address, quoted_price, agreed_price, floor_price, advance_amount)
       VALUES ($1,$2,$3,'2026-12-20','Kondapur',12000,11000,10800,3000) RETURNING id, booking_code`,
      [f.tenantId, f.contactId, f.packageId]);
    expect(b.booking_code).toMatch(/^BB-\d+$/);

    const pay = (amt, kind = 'payment', ref = null) => c.query(
      `INSERT INTO booking_payments (tenant_id, booking_id, amount, method, kind, reference) VALUES ($1,$2,$3,'upi',$4,$5)`,
      [f.tenantId, b.id, amt, kind, ref]);
    const state = () => one(c, `SELECT advance_paid_amount::int paid, advance_status, balance_amount::int bal FROM bookings WHERE id = $1`, [b.id]);

    await pay(1000, 'payment', 'UTR1');
    expect(await state()).toEqual({ paid: 1000, advance_status: 'partial', bal: 10000 });
    await pay(2000, 'payment', 'UTR2');
    expect(await state()).toEqual({ paid: 3000, advance_status: 'paid', bal: 8000 });
    await expectPgError(sp(c, () => pay(500, 'payment', 'UTR1')), '23505');        // same UTR twice
    await expectPgError(sp(c, () => pay(9000)), '23514');                          // overpay beyond agreed price

    await c.query(`SET LOCAL bb.actor_type = 'agent'`);
    await c.query(`UPDATE bookings SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [b.id]);
    const hist = (await c.query(
      `SELECT from_status, to_status, actor_type FROM booking_status_history WHERE booking_id = $1 ORDER BY created_at, to_status`, [b.id])).rows;
    expect(hist).toEqual(expect.arrayContaining([
      { from_status: null, to_status: 'advance_pending', actor_type: 'system' },
      { from_status: 'advance_pending', to_status: 'confirmed', actor_type: 'agent' },
    ]));
  }));

  test('only one open lead per contact', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const ins = (status) => c.query(
      `INSERT INTO leads (tenant_id, contact_id, status, lost_reason) VALUES ($1,$2,$3,$4)`,
      [f.tenantId, f.contactId, status, status === 'lost' ? 'price' : null]);
    await ins('qualifying');
    await expectPgError(sp(c, () => ins('new')), '23505');
    await ins('lost');   // closed leads don't count
  }));
});

describe('gallery sendability', () => {
  async function item(f, overrides) {
    const asset = await one(c,
      `INSERT INTO gallery_assets (tenant_id, sha256, storage_key, public_url, size_bytes)
       VALUES ($1, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'k', 'https://x/y.jpg', 1000) RETURNING id`, [f.tenantId]);
    const v = { quality: 'proper', pmin: 10000, pmax: 12000, src: 'filename', path: `p/${Math.random()}.jpg`, ...overrides };
    return one(c,
      `INSERT INTO gallery_items (tenant_id, asset_id, source, source_path, parsed_title, name_quality,
                                  parsed_package_id, parsed_price_min, parsed_price_max, parsed_price_source)
       VALUES ($1,$2,'zip',$3,'Dinosaur Theme',$4,$5,$6,$7,$8) RETURNING id, is_sendable`,
      [f.tenantId, asset.id, v.path, v.quality, f.packageId, v.pmin, v.pmax, v.src]);
  }

  test('only properly named AND priced photos are sendable', () => rollback(c, async () => {
    const f = await baseFixture(c);
    expect((await item(f, {})).is_sendable).toBe(true);
    expect((await item(f, { quality: 'price_only' })).is_sendable).toBe(true);
    expect((await item(f, { quality: 'generic' })).is_sendable).toBe(false);
    expect((await item(f, { pmin: null, pmax: null, src: 'none' })).is_sendable).toBe(false);
  }));

  test('admin overrides make a photo sendable and survive a re-sync of parsed fields', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const it = await item(f, { pmin: null, pmax: null, src: 'none' });
    await c.query(`UPDATE gallery_items SET override_price_min = 7000, override_price_max = 8000 WHERE id = $1`, [it.id]);
    // simulate the sync job rewriting parsed columns only
    await c.query(`UPDATE gallery_items SET parsed_title = 'Renamed', last_synced_at = now() WHERE id = $1`, [it.id]);
    const r = await one(c, `SELECT is_sendable, price_min::int, title FROM gallery_items WHERE id = $1`, [it.id]);
    expect(r).toEqual({ is_sendable: true, price_min: 7000, title: 'Renamed' });
    await c.query(`UPDATE gallery_items SET override_hidden = true WHERE id = $1`, [it.id]);
    expect((await one(c, `SELECT is_sendable FROM gallery_items WHERE id = $1`, [it.id])).is_sendable).toBe(false);
  }));

  test('a parsed price source must agree with the parsed price', () => rollback(c, async () => {
    const f = await baseFixture(c);
    await expectPgError(sp(c, () => item(f, { src: 'none' })), '23514');
    await expectPgError(sp(c, () => item(f, { pmin: 12000, pmax: 10000 })), '23514');
  }));
});

describe('audit log', () => {
  test('is append-only, but tolerates user deletion (SET NULL)', () => rollback(c, async () => {
    const f = await baseFixture(c);
    const role = await one(c, `SELECT id FROM roles WHERE tenant_id = $1 AND key = 'agent'`, [f.tenantId]);
    const u = await one(c, `INSERT INTO users (tenant_id, role_id, full_name, email) VALUES ($1,$2,'A','a@example.com') RETURNING id`,
      [f.tenantId, role.id]);
    const a = await one(c,
      `INSERT INTO audit_log (tenant_id, actor_type, actor_user_id, action, entity_type) VALUES ($1,'user',$2,'pricing_rule.update','pricing_rule') RETURNING id`,
      [f.tenantId, u.id]);
    await expectPgError(sp(c, () => c.query(`UPDATE audit_log SET action = 'x.y' WHERE id = $1`, [a.id])), 'P0001');
    await expectPgError(sp(c, () => c.query(`DELETE FROM audit_log WHERE id = $1`, [a.id])), 'P0001');
    await c.query(`DELETE FROM users WHERE id = $1`, [u.id]);
    expect((await one(c, `SELECT actor_user_id FROM audit_log WHERE id = $1`, [a.id])).actor_user_id).toBeNull();
  }));

  test('deleting a tenant cascades through everything, including the audit log', () => rollback(c, async () => {
    const t = await one(c, `INSERT INTO tenants (slug, name) VALUES ('tmp-tenant','Tmp') RETURNING id`);
    await c.query(`INSERT INTO audit_log (tenant_id, actor_type, action, entity_type) VALUES ($1,'system','tenant.create','tenant')`, [t.id]);
    await c.query(`DELETE FROM tenants WHERE id = $1`, [t.id]);
    expect((await one(c, `SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1`, [t.id])).n).toBe(0);
  }));
});

describe('AI agent config & tools', () => {
  test('the agent defaults to DeepSeek with no key stored in the DB (env key is used)', async () => {
    const r = await one(c, `SELECT provider, model, api_key_enc FROM ai_agent_config`);
    expect(r).toEqual({ provider: 'deepseek', model: 'deepseek-flash', api_key_enc: null });
  });

  test('all 9 tools are seeded; safety tools are required and cannot be switched off', () => rollback(c, async () => {
    const tools = (await c.query(`SELECT name, is_required FROM ai_tools ORDER BY sort_order`)).rows;
    expect(tools.map((t) => t.name)).toEqual([
      'get_pricing', 'send_photos', 'calculate_distance_charge', 'check_negotiation_limit', 'create_booking',
      'handover_to_human', 'request_location', 'update_lead', 'schedule_followup']);
    expect(tools.filter((t) => t.is_required).map((t) => t.name).sort())
      .toEqual(['check_negotiation_limit', 'get_pricing', 'handover_to_human']);
    await expectPgError(sp(c, () => c.query(`UPDATE ai_tools SET is_enabled = false WHERE name = 'handover_to_human'`)), '23514');
    await c.query(`UPDATE ai_tools SET is_enabled = false WHERE name = 'schedule_followup'`);
  }));

  test('tool descriptions are editable but cannot be blanked; default is kept for reset', () => rollback(c, async () => {
    await c.query(`UPDATE ai_tools SET description = 'Send up to 4 photos of our latest designs.' WHERE name = 'send_photos'`);
    const r = await one(c, `SELECT description <> default_description AS changed FROM ai_tools WHERE name = 'send_photos'`);
    expect(r.changed).toBe(true);
    await expectPgError(sp(c, () => c.query(`UPDATE ai_tools SET description = '  ' WHERE name = 'send_photos'`)), '23514');
  }));

  test('unknown providers are rejected', () => rollback(c, async () => {
    await expectPgError(sp(c, () => c.query(`UPDATE ai_agent_config SET provider = 'acme'`)), '23514');
  }));
});

describe('seed data', () => {
  test('no seeded price is marked confirmed (all are TODO for the client)', async () => {
    const r = await one(c, `
      SELECT (SELECT count(*) FROM packages WHERE price_confirmed)::int p,
             (SELECT count(*) FROM pricing_rules WHERE price_confirmed)::int r,
             (SELECT count(*) FROM distance_slabs WHERE price_confirmed)::int s`);
    expect(r).toEqual({ p: 0, r: 0, s: 0 });
  });

  test('Drive folder typos resolve to canonical themes', async () => {
    const map = (await c.query(`
      SELECT a.alias, t.key FROM theme_aliases a JOIN themes t ON t.id = a.theme_id
      WHERE a.alias IN ('birbe','dinosour','pegga pig','paw petrol','trasformer','vehicals','sipder man','roblex','oscan')`))
      .rows.reduce((m, r) => ({ ...m, [r.alias]: r.key }), {});
    expect(map).toEqual({
      birbe: 'barbie', dinosour: 'dinosaur', 'pegga pig': 'peppa_pig', 'paw petrol': 'paw_patrol',
      trasformer: 'transformers', vehicals: 'vehicles', 'sipder man': 'spiderman', roblex: 'roblox', oscan: 'underwater',
    });
  });

  test('automations are seeded switched off', async () => {
    expect((await one(c, `SELECT count(*)::int n FROM automations WHERE is_active`)).n).toBe(0);
  });
});
