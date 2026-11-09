const { distanceCharge, resolveBasePrice, pickNegotiationRule, computeFloor, negotiate, buildQuote } = require('../../src/pricing/engine');

const SLABS = [
  { min_km: 0, max_km: 5, charge_type: 'free', amount: 0, label: 'Within 5 km' },
  { min_km: 5, max_km: 10, charge_type: 'flat', amount: 300, label: '5–10 km' },
  { min_km: 10, max_km: 20, charge_type: 'per_km', amount: 45, label: '10–20 km' },
  { min_km: 20, max_km: 35, charge_type: 'flat', amount: 1000, label: '20–35 km' },
  { min_km: 35, max_km: null, charge_type: 'not_serviceable', amount: 0, label: 'Beyond 35 km' },
];

describe('distanceCharge: slab edges', () => {
  test.each([
    [0, true, 0],
    [4.99, true, 0],
    [5.0, true, 300],       // [min, max): 5.0 km is in the 5–10 band
    [5.01, true, 300],
    [9.99, true, 300],
    [10, true, 0],          // per_km starts counting at the band's start
    [12.3, true, 110],      // 45 × 2.3 = 103.5 → rounded up to ₹10
    [20, true, 1000],
    [34.99, true, 1000],
  ])('%s km -> serviceable=%s charge=%i', (km, serviceable, charge) => {
    expect(distanceCharge(km, SLABS)).toMatchObject({ serviceable, charge });
  });

  test('not_serviceable band (out of area)', () => {
    expect(distanceCharge(35, SLABS)).toMatchObject({ serviceable: false, reason: 'not_serviceable' });
    expect(distanceCharge(80, SLABS)).toMatchObject({ serviceable: false, reason: 'not_serviceable' });
  });
  test('max_service_km beats the slabs', () => {
    expect(distanceCharge(25, SLABS, { maxServiceKm: 22 })).toMatchObject({ serviceable: false, reason: 'beyond_max_service_km' });
  });
  test('gap in the slabs is not serviceable', () => {
    expect(distanceCharge(3, [{ min_km: 5, max_km: null, charge_type: 'flat', amount: 100 }])).toMatchObject({ serviceable: false, reason: 'no_slab' });
  });
  test('inactive slabs are ignored', () => {
    expect(distanceCharge(7, [{ ...SLABS[1], is_active: false }])).toMatchObject({ serviceable: false });
  });
  test('rejects nonsense', () => {
    expect(() => distanceCharge(-1, SLABS)).toThrow();
    expect(() => distanceCharge('abc', SLABS)).toThrow();
  });
});

const PKG = { id: 'pkg-2f', key: 'two_frames', name: '2 Frames Decor', price_min: 6500, price_max: 20000, price_confirmed: false };

describe('resolveBasePrice', () => {
  const rules = [
    { id: 'r-pkg', package_id: 'pkg-2f', rule_type: 'base_price', price_min: 9000, price_max: 11000 },
    { id: 'r-theme', package_id: 'pkg-2f', theme_id: 'dino', rule_type: 'base_price', price_min: 10000, price_max: 12000 },
    { id: 'r-theme-occ', package_id: 'pkg-2f', theme_id: 'dino', occasion_id: 'bday', rule_type: 'base_price', price_min: 10500, price_max: 12500 },
    { id: 'r-old', package_id: 'pkg-2f', rule_type: 'base_price', price_min: 1, price_max: 2, priority: 99, valid_to: '2020-01-01' },
  ];
  test('gallery item price wins', () => {
    expect(resolveBasePrice({ pkg: PKG, rules, galleryItem: { price_min: 10000, price_max: 12000 } })).toMatchObject({ min: 10000, max: 12000, source: 'gallery_item' });
  });
  test('most specific rule wins', () => {
    expect(resolveBasePrice({ pkg: PKG, rules, themeId: 'dino', occasionId: 'bday', onDate: '2026-12-01' }).rule_id).toBe('r-theme-occ');
    expect(resolveBasePrice({ pkg: PKG, rules, themeId: 'dino', onDate: '2026-12-01' }).rule_id).toBe('r-theme');
    expect(resolveBasePrice({ pkg: PKG, rules, onDate: '2026-12-01' }).rule_id).toBe('r-pkg');
  });
  test('falls back to the package range', () => {
    expect(resolveBasePrice({ pkg: PKG, rules: [] })).toMatchObject({ min: 6500, max: 20000, source: 'package' });
  });
  test('no price anywhere', () => {
    expect(resolveBasePrice({ pkg: { id: 'x', price_min: null }, rules: [] })).toBeNull();
  });
});

describe('negotiation rule selection', () => {
  const rules = [
    { id: 'g', scope: 'global', max_discount_pct: 10 },
    { id: 'p', scope: 'package', package_id: 'pkg-2f', max_discount_pct: 8 },
    { id: 't', scope: 'theme', theme_id: 'dino', max_discount_pct: 5 },
    { id: 'tp', scope: 'theme', theme_id: 'dino', package_id: 'pkg-2f', max_discount_pct: 3 },
  ];
  test('theme+package > theme > package > global', () => {
    expect(pickNegotiationRule(rules, { packageId: 'pkg-2f', themeId: 'dino' }).id).toBe('tp');
    expect(pickNegotiationRule(rules, { packageId: 'other', themeId: 'dino' }).id).toBe('t');
    expect(pickNegotiationRule(rules, { packageId: 'pkg-2f', themeId: 'cars' }).id).toBe('p');
    expect(pickNegotiationRule(rules, { packageId: 'other' }).id).toBe('g');
    expect(pickNegotiationRule([], {})).toBeNull();
  });
});

describe('computeFloor: discount caps', () => {
  test('% only', () => {
    expect(computeFloor({ listPrice: 12000, rule: { max_discount_pct: 10 } })).toMatchObject({ full: 12000, floor: 10800 });
  });
  test('₹ only', () => {
    expect(computeFloor({ listPrice: 12000, rule: { max_discount_amount: 500 } })).toMatchObject({ floor: 11500 });
  });
  test('% and ₹: the more restrictive (smaller discount) wins', () => {
    // 10% of 12000 = 1200, ₹ cap 800 -> 800
    expect(computeFloor({ listPrice: 12000, rule: { max_discount_pct: 10, max_discount_amount: 800 } })).toMatchObject({ floor: 11200, maxDiscount: 800 });
    // 10% of 5000 = 500, ₹ cap 800 -> 500
    expect(computeFloor({ listPrice: 5000, rule: { max_discount_pct: 10, max_discount_amount: 800 } })).toMatchObject({ floor: 4500, maxDiscount: 500 });
  });
  test('absolute minimum price raises the floor', () => {
    expect(computeFloor({ listPrice: 12000, rule: { max_discount_pct: 20, min_final_price: 11000 } })).toMatchObject({ floor: 11000 });
  });
  test('add-ons and distance are outside the discount unless the rule includes them', () => {
    const rule = { max_discount_pct: 10 };
    // only the design (10000) is discountable: max 1000 off a full 10000+2000+300
    expect(computeFloor({ listPrice: 10000, addonsTotal: 2000, distanceCharge: 300, rule })).toMatchObject({ full: 12300, floor: 11300 });
    // add-ons inside: 10% of 12000
    expect(computeFloor({ listPrice: 10000, addonsTotal: 2000, distanceCharge: 300, rule: { ...rule, applies_to_addons: true } })).toMatchObject({ floor: 11100 });
    // add-ons and distance inside: 10% of 12300 = 1230
    expect(computeFloor({ listPrice: 10000, addonsTotal: 2000, distanceCharge: 300, rule: { ...rule, applies_to_addons: true, applies_to_distance_charge: true } })).toMatchObject({ floor: 11070 });
  });
  test('no rule means no discount', () => {
    expect(computeFloor({ listPrice: 9000, rule: null })).toMatchObject({ floor: 9000, maxDiscount: 0 });
  });
});

describe('negotiate', () => {
  const rule = { max_discount_pct: 10, concession_step_pct: 5, max_rounds: 2 };
  const base = { full: 12000, floor: 10800, rule };

  test('offer at or above the ask is accepted', () => {
    expect(negotiate({ ...base, offer: 12000 })).toMatchObject({ decision: 'accept', price: 12000 });
    expect(negotiate({ ...base, offer: 13000 })).toMatchObject({ decision: 'accept', price: 12000 });
  });
  test('concedes one step per round, never below the floor, then stops', () => {
    const r1 = negotiate({ ...base, offer: 9000 });
    expect(r1).toMatchObject({ decision: 'counter', price: 11400, rounds_used: 1, below_floor: true });
    const r2 = negotiate({ ...base, offer: 9000, currentAsk: r1.price, roundsUsed: 1 });
    expect(r2).toMatchObject({ decision: 'final_offer', price: 10800, rounds_used: 2, at_floor: true });
    const r3 = negotiate({ ...base, offer: 9000, currentAsk: r2.price, roundsUsed: 2 });
    expect(r3).toMatchObject({ decision: 'final_offer', price: 10800, rounds_used: 2 });
  });
  test('an offer that meets the next concession is accepted as offered', () => {
    expect(negotiate({ ...base, offer: 11500 })).toMatchObject({ decision: 'accept', price: 11500, rounds_used: 1 });
  });
  test('rounds exhausted before the floor: holds the current ask', () => {
    const r = negotiate({ full: 20000, floor: 16000, rule: { concession_step_pct: 5, max_rounds: 1 }, offer: 15000, currentAsk: 19000, roundsUsed: 1 });
    expect(r).toMatchObject({ decision: 'final_offer', price: 19000 });
  });
  test('no rule: no discount', () => {
    expect(negotiate({ full: 5000, floor: 5000, rule: null, offer: 4000 })).toMatchObject({ decision: 'final_offer', price: 5000 });
  });
  test('floor is never crossed for any offer', () => {
    for (let offer = 0; offer <= 14000; offer += 137) {
      let ask = null; let rounds = 0;
      for (let i = 0; i < 5; i += 1) {
        const r = negotiate({ ...base, offer, currentAsk: ask, roundsUsed: rounds });
        expect(r.price).toBeGreaterThanOrEqual(10800);
        if (r.decision === 'accept') break;
        ask = r.price; rounds = r.rounds_used;
      }
    }
  });
  test('rejects a floor above the full price', () => {
    expect(() => negotiate({ full: 100, floor: 200, offer: 50, rule })).toThrow();
  });
});

describe('buildQuote', () => {
  const negotiationRules = [{ id: 'g', scope: 'global', max_discount_pct: 10, concession_step_pct: 5, max_rounds: 2 }];
  const cutout = { id: 'pkg-cut', key: 'addon_cutout', name: 'Cut-outs', kind: 'addon', price_min: 500, price_max: 800 };

  test('design + add-on + distance; floor only discounts the design', () => {
    const q = buildQuote({
      pkg: PKG, galleryItem: { title: 'Dinosaur Theme', price_min: 10000, price_max: 12000 },
      addons: [{ pkg: cutout, quantity: 2 }], km: 7.2, slabs: SLABS, negotiationRules,
    });
    expect(q).toMatchObject({
      ok: true, list_price: 12000, addons_total: 1600, distance_charge: 300, full_price: 13900, floor_price: 12700, serviceable: true,
    });
    expect(q.line_items.map((l) => l.kind)).toEqual(['design', 'addon', 'distance']);
    expect(q.unconfirmed.length).toBeGreaterThan(0);
  });
  test('out of area: no distance line, serviceable=false', () => {
    const q = buildQuote({ pkg: PKG, km: 50, slabs: SLABS, negotiationRules });
    expect(q).toMatchObject({ ok: true, serviceable: false, distance_charge: 0 });
  });
  test('distance unknown yet', () => {
    expect(buildQuote({ pkg: PKG, slabs: SLABS })).toMatchObject({ ok: true, serviceable: null, distance: null });
  });
  test('unpriced design is refused, never invented', () => {
    expect(buildQuote({ pkg: { id: 'w', name: 'Welcome Arch', price_min: null } })).toMatchObject({ ok: false, reason: 'no_price' });
  });
  test('unit add-on below minimum quantity', () => {
    const bunch = { id: 'b', key: 'bunch_unit', name: 'Bunch', kind: 'unit', price_min: 40, price_max: 40, min_quantity: 10 };
    expect(buildQuote({ pkg: PKG, addons: [{ pkg: bunch, quantity: 5 }] })).toMatchObject({ ok: false, reason: 'below_min_quantity' });
    expect(buildQuote({ pkg: PKG, addons: [{ pkg: bunch, quantity: 12 }] })).toMatchObject({ ok: true, addons_total: 480 });
  });
});
