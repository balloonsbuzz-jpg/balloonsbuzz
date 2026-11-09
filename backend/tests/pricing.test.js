// Pricing & Rules API: catalogue, distance slabs + base pin, negotiation limits, quote calculator.
const { pool, signedIn } = require('./helpers');

let owner;
let agent;
let catalog;
const pkg = (key) => catalog.packages.find((p) => p.key === key);

beforeAll(async () => {
  owner = await signedIn('owner');
  agent = await signedIn('agent');
  catalog = (await owner.get('/api/pricing/catalog')).body;
});

describe('catalogue', () => {
  test('lists packages, themes with aliases, occasions', () => {
    expect(pkg('two_frames')).toMatchObject({ name: '2 Frames Decor', price_confirmed: false });
    const dino = catalog.themes.find((t) => t.key === 'dinosaur');
    expect(dino.aliases.map((a) => a.alias)).toEqual(expect.arrayContaining(['dinosour', 'dino']));
    expect(catalog.occasions.length).toBeGreaterThan(5);
  });

  test('owner edits a package price; agents cannot', async () => {
    const id = pkg('welcome_arch').id;
    expect((await agent.patch(`/api/pricing/packages/${id}`, { price_min: 6000 })).status).toBe(403);
    const r = await owner.patch(`/api/pricing/packages/${id}`, { price_min: 6000, price_max: 9000, price_confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body.package).toMatchObject({ price_min: '6000.00', price_max: '9000.00', price_confirmed: true });
    expect((await owner.patch(`/api/pricing/packages/${id}`, { price_min: 9500 })).status).toBe(400);   // above max: DB check
  });

  test('new theme with aliases; duplicate alias refused', async () => {
    const r = await owner.post('/api/pricing/themes', { name: 'Pokemon', aliases: ['pikachu'] });
    expect(r.status).toBe(201);
    const dup = await owner.post(`/api/pricing/themes/${r.body.theme.id}/aliases`, { alias: 'dino' });
    expect(dup.status).toBe(409);
    const ok = await owner.post(`/api/pricing/themes/${r.body.theme.id}/aliases`, { alias: 'Pokémon go' });
    expect(ok.status).toBe(201);
    expect((await owner.del(`/api/pricing/aliases/${ok.body.alias.id}`)).status).toBe(204);
  });
});

describe('distance', () => {
  test('slab table: must start at 0, join up, and only the last band is open-ended', async () => {
    const bad = [
      [{ min_km: 1, max_km: 5, charge_type: 'free' }],
      [{ min_km: 0, max_km: 5, charge_type: 'free' }, { min_km: 6, max_km: null, charge_type: 'flat', amount: 100 }],
      [{ min_km: 0, max_km: null, charge_type: 'free' }, { min_km: 5, max_km: 10, charge_type: 'flat', amount: 100 }],
    ];
    for (const slabs of bad) expect((await owner.put('/api/pricing/distance/slabs', { slabs })).status).toBe(400);
  });

  test('replaces the slab table', async () => {
    const slabs = [
      { min_km: 0, max_km: 5, charge_type: 'free', label: 'Within 5 km' },
      { min_km: 5, max_km: 10, charge_type: 'flat', amount: 300, label: '5–10 km' },
      { min_km: 10, max_km: 30, charge_type: 'per_km', amount: 40, label: '10–30 km' },
      { min_km: 30, max_km: null, charge_type: 'not_serviceable', label: 'Beyond 30 km' },
    ];
    const r = await owner.put('/api/pricing/distance/slabs', { slabs });
    expect(r.status).toBe(200);
    expect(r.body.slabs).toHaveLength(4);
  });

  test.each([[4.99, 0, true], [5.0, 300, true], [5.01, 300, true], [12.5, 100, true], [30, 0, false]])(
    '%s km -> ₹%i (serviceable %s)', async (km, charge, serviceable) => {
      const r = await owner.post('/api/pricing/distance/check', { km });
      expect(r.body).toMatchObject({ charge, serviceable });
    });

  test('a venue pin needs the base pin first', async () => {
    const venue = { lat: 17.4948, lng: 78.3563 };
    const r = await owner.post('/api/pricing/distance/check', { location: venue });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/base location/i);

    const base = await owner.put('/api/pricing/distance/base', { base_lat: 17.4967, base_lng: 78.3577 - 0.06, road_factor: 1.3, max_service_km: 40 });
    expect(base.status).toBe(200);
    const ok = await owner.post('/api/pricing/distance/check', { location: venue });
    expect(ok.status).toBe(200);
    expect(ok.body.lookup).toMatchObject({ method: 'estimate' });
    expect(ok.body.lookup.km).toBeCloseTo(ok.body.lookup.straight_km * 1.3, 1);
    expect(ok.body.serviceable).toBe(true);
  });

  test('base pin needs both coordinates', async () => {
    expect((await owner.put('/api/pricing/distance/base', { base_lat: 17.5 })).status).toBe(400);
  });
});

describe('negotiation limits', () => {
  test('global rule exists and can be changed but not removed', async () => {
    const list = await owner.get('/api/pricing/negotiation');
    const global = list.body.rules.find((r) => r.scope === 'global');
    expect(global).toBeTruthy();
    const r = await owner.patch(`/api/pricing/negotiation/${global.id}`, { max_discount_pct: 10, max_discount_amount: 1000, max_rounds: 2 });
    expect(r.status).toBe(200);
    expect((await owner.del(`/api/pricing/negotiation/${global.id}`)).status).toBe(400);
  });

  test('a rule needs at least one limit; one package rule per package', async () => {
    const id = pkg('basic').id;
    expect((await owner.post('/api/pricing/negotiation', { scope: 'package', package_id: id })).status).toBe(400);
    expect((await owner.post('/api/pricing/negotiation', { scope: 'package', package_id: id, max_discount_pct: 5 })).status).toBe(201);
    expect((await owner.post('/api/pricing/negotiation', { scope: 'package', package_id: id, max_discount_pct: 6 })).status).toBe(409);
  });
});

describe('quote calculator', () => {
  test('package price + distance; the floor follows the most restrictive cap', async () => {
    const r = await owner.post('/api/pricing/quote', { package_id: pkg('semi_arch').id, km: 7 });
    expect(r.status).toBe(200);
    // semi arch ₹6k–10k -> list 10000; global: 10% (1000) vs ₹1000 cap -> 1000 off the design only
    expect(r.body.quote).toMatchObject({ ok: true, list_price: 10000, distance_charge: 300, full_price: 10300, floor_price: 9300 });
  });

  test('negotiation turn never goes below the floor', async () => {
    const r = await owner.post('/api/pricing/quote', { package_id: pkg('semi_arch').id, km: 7, offer: 7000 });
    expect(r.body.negotiation).toMatchObject({ decision: 'counter', below_floor: true });
    expect(r.body.negotiation.price).toBeGreaterThanOrEqual(9300);
    const r2 = await owner.post('/api/pricing/quote', { package_id: pkg('semi_arch').id, km: 7, offer: 7000, current_ask: r.body.negotiation.price, rounds_used: 1 });
    expect(r2.body.negotiation).toMatchObject({ decision: 'final_offer', price: 9300 });
  });

  test('basic package uses its own (tighter) rule', async () => {
    const r = await owner.post('/api/pricing/quote', { package_id: pkg('basic').id });
    expect(r.body.quote).toMatchObject({ list_price: 5000, floor_price: 4750 });
  });

  test('unpriced design is refused rather than invented', async () => {
    const r = await owner.post('/api/pricing/quote', { package_id: pkg('helium_decor').id });
    expect(r.body.quote).toMatchObject({ ok: false, reason: 'no_price' });
  });

  test('out of area', async () => {
    const r = await owner.post('/api/pricing/quote', { package_id: pkg('semi_arch').id, km: 45 });
    expect(r.body.quote).toMatchObject({ ok: true, serviceable: false, distance_charge: 0 });
  });

  test('needs a package or a photo', async () => {
    expect((await owner.post('/api/pricing/quote', { km: 3 })).status).toBe(400);
  });
});

describe('business settings', () => {
  test('read and update advance + UPI; validation', async () => {
    const r = await owner.put('/api/settings/business', { advance_type: 'percent', advance_value: 30, upi_vpa: 'balloonsbuzz@okhdfc', staff_alert_phones: ['+919392534625'] });
    expect(r.status).toBe(200);
    expect(r.body.business).toMatchObject({ advance_value: '30.00', staff_alert_phones: ['919392534625'] });
    expect((await owner.put('/api/settings/business', { advance_type: 'percent', advance_value: 130 })).status).toBe(400);
    expect((await owner.put('/api/settings/business', { upi_vpa: 'not a upi' })).status).toBe(400);
    expect((await agent.put('/api/settings/business', { advance_value: 10 })).status).toBe(403);
    const { rows: [a] } = await pool.query(`SELECT action FROM audit_log WHERE action = 'business_settings.update' LIMIT 1`);
    expect(a).toBeTruthy();
  });
});
