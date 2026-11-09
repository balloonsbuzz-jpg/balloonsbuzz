// Quote engine: pure functions, no I/O. All money is in whole rupees.
//
// The AI never calculates prices itself: it calls tools that run this code, and
// the outbound guard (M6) refuses replies quoting a number this engine didn't produce.
//
//   full price  = design list price + add-ons + distance charge
//   floor price = full price − the largest discount the negotiation rule allows
//   every price we ever offer is >= floor (asserted, and CHECKed again in the DB)

const rupees = (n) => Math.round(Number(n));
const num = (v) => (v == null || v === '' ? null : Number(v));
const ceilTo = (n, step) => Math.ceil(n / step) * step;

// ── distance ────────────────────────────────────────────────────

/**
 * Slabs are [min_km, max_km) bands: 5.0 km falls in the 5–10 band, 4.99 km in 0–5.
 * per_km slabs charge `amount` for every km beyond the band's start, rounded up to ₹10.
 * @returns {{km:number, serviceable:boolean, charge:number, slab:object|null, label:string|null, reason?:string}}
 */
function distanceCharge(km, slabs, { maxServiceKm = null } = {}) {
  const d = Number(km);
  if (!Number.isFinite(d) || d < 0) throw new Error('distance must be a non-negative number of km');
  const rounded = Math.round(d * 100) / 100;
  if (maxServiceKm != null && d > Number(maxServiceKm)) {
    return { km: rounded, serviceable: false, charge: 0, slab: null, label: null, reason: 'beyond_max_service_km' };
  }
  const active = (slabs || []).filter((s) => s.is_active !== false)
    .map((s) => ({ ...s, min_km: Number(s.min_km), max_km: num(s.max_km), amount: Number(s.amount || 0) }))
    .sort((a, b) => a.min_km - b.min_km);
  const slab = active.find((s) => d >= s.min_km && (s.max_km == null || d < s.max_km));
  if (!slab) return { km: rounded, serviceable: false, charge: 0, slab: null, label: null, reason: 'no_slab' };

  let charge = 0;
  switch (slab.charge_type) {
    case 'free': charge = 0; break;
    case 'flat': charge = rupees(slab.amount); break;
    case 'per_km': charge = ceilTo(slab.amount * (d - slab.min_km), 10); break;
    case 'not_serviceable':
      return { km: rounded, serviceable: false, charge: 0, slab, label: slab.label || null, reason: 'not_serviceable' };
    default: throw new Error(`unknown slab type ${slab.charge_type}`);
  }
  return { km: rounded, serviceable: true, charge, slab, label: slab.label || null };
}

// ── design price ────────────────────────────────────────────────

function ruleApplies(rule, { themeId, occasionId, onDate }) {
  if (rule.is_active === false) return false;
  if (rule.theme_id && rule.theme_id !== themeId) return false;
  if (rule.occasion_id && rule.occasion_id !== occasionId) return false;
  if (onDate) {
    const day = String(onDate).slice(0, 10);
    if (rule.valid_from && String(rule.valid_from).slice(0, 10) > day) return false;
    if (rule.valid_to && String(rule.valid_to).slice(0, 10) < day) return false;
  }
  return true;
}
const specificity = (r) => (r.theme_id ? 2 : 0) + (r.occasion_id ? 1 : 0);

/**
 * The design's price range. Most specific source wins:
 * the photo the customer picked > pricing rule (theme+occasion > theme > occasion > package) > package range.
 * @returns {{min, max, source, rule_id, confirmed} | null}
 */
function resolveBasePrice({ pkg, rules = [], themeId = null, occasionId = null, galleryItem = null, onDate = null }) {
  if (galleryItem && galleryItem.price_min != null) {
    return {
      min: rupees(galleryItem.price_min), max: rupees(galleryItem.price_max ?? galleryItem.price_min),
      source: 'gallery_item', rule_id: null, confirmed: false,
    };
  }
  const matching = rules
    .filter((r) => r.package_id === pkg.id && r.rule_type === 'base_price' && ruleApplies(r, { themeId, occasionId, onDate }))
    .sort((a, b) => specificity(b) - specificity(a) || (b.priority || 0) - (a.priority || 0));
  if (matching.length) {
    const r = matching[0];
    return { min: rupees(r.price_min), max: rupees(r.price_max), source: 'pricing_rule', rule_id: r.id, confirmed: !!r.price_confirmed };
  }
  if (pkg.price_min != null) {
    return { min: rupees(pkg.price_min), max: rupees(pkg.price_max ?? pkg.price_min), source: 'package', rule_id: null, confirmed: !!pkg.price_confirmed };
  }
  return null;
}

// ── negotiation limits ──────────────────────────────────────────

/** Most specific active rule: theme+package > theme > package > global. */
function pickNegotiationRule(rules, { packageId = null, themeId = null } = {}) {
  const active = (rules || []).filter((r) => r.is_active !== false);
  return active.find((r) => r.scope === 'theme' && r.theme_id === themeId && r.package_id && r.package_id === packageId)
    || active.find((r) => r.scope === 'theme' && r.theme_id === themeId && !r.package_id)
    || active.find((r) => r.scope === 'package' && r.package_id === packageId)
    || active.find((r) => r.scope === 'global')
    || null;
}

/**
 * Lowest price we may accept. With both a % and a ₹ cap, the smaller discount wins.
 * Add-ons and the distance charge are only discountable when the rule says so.
 * No rule = no discount at all.
 */
function computeFloor({ listPrice, addonsTotal = 0, distanceCharge: dist = 0, rule }) {
  const full = rupees(listPrice) + rupees(addonsTotal) + rupees(dist);
  if (!rule) return { full, floor: full, maxDiscount: 0, discountable: 0 };

  const discountable = rupees(listPrice)
    + (rule.applies_to_addons ? rupees(addonsTotal) : 0)
    + (rule.applies_to_distance_charge ? rupees(dist) : 0);

  const caps = [];
  if (num(rule.max_discount_pct) != null) caps.push(Math.floor((discountable * Number(rule.max_discount_pct)) / 100));
  if (num(rule.max_discount_amount) != null) caps.push(Math.floor(Number(rule.max_discount_amount)));
  let maxDiscount = caps.length ? Math.min(...caps) : discountable;
  maxDiscount = Math.max(0, Math.min(maxDiscount, discountable));

  let floor = full - maxDiscount;
  if (num(rule.min_final_price) != null) floor = Math.max(floor, Math.min(rupees(rule.min_final_price), full));
  return { full, floor, maxDiscount: full - floor, discountable };
}

/**
 * One negotiation turn. Concedes at most one step per round, never below the floor,
 * and stops conceding after max_rounds.
 *
 * @param {object} p
 * @param {number} p.full      full price (list + add-ons + distance)
 * @param {number} p.floor     from computeFloor()
 * @param {number} p.offer     what the customer asked for
 * @param {number} [p.currentAsk] our last offered price (defaults to full)
 * @param {number} [p.roundsUsed]
 * @param {object|null} p.rule negotiation rule (step %, max rounds)
 * @returns {{decision:'accept'|'counter'|'final_offer', price:number, rounds_used:number, floor:number,
 *            below_floor:boolean, at_floor:boolean}}
 */
function negotiate({ full, floor, offer, currentAsk = null, roundsUsed = 0, rule }) {
  const F = rupees(full); const L = rupees(floor); const o = rupees(offer);
  if (!(L <= F)) throw new Error('floor must not exceed full price');
  if (!Number.isFinite(o) || o < 0) throw new Error('offer must be a non-negative number');
  const ask = Math.max(L, Math.min(F, currentAsk == null ? F : rupees(currentAsk)));
  const maxRounds = rule ? Number(rule.max_rounds ?? 0) : 0;
  const stepPct = rule ? Number(rule.concession_step_pct ?? 5) : 0;

  const out = (decision, price, rounds) => {
    const p = rupees(price);
    if (p < L) throw new Error(`negotiation produced ${p} below floor ${L}`); // must never happen
    return { decision, price: p, rounds_used: rounds, floor: L, below_floor: o < L, at_floor: p === L };
  };

  if (o >= ask) return out('accept', Math.min(o, ask), roundsUsed);

  const canConcede = rule && ask > L && roundsUsed < maxRounds;
  if (!canConcede) return out('final_offer', ask, roundsUsed);

  // One step = concession_step_pct of the full price, in ₹50s; rounding up never undercuts the floor.
  const step = Math.max(50, ceilTo((F * stepPct) / 100, 50));
  const nextAsk = Math.max(L, ceilTo(ask - step, 50));
  // The customer's offer already meets our next concession: take it.
  if (o >= nextAsk) return out('accept', o, roundsUsed + 1);
  const rounds = roundsUsed + 1;
  const last = nextAsk === L || rounds >= maxRounds;
  return out(last ? 'final_offer' : 'counter', nextAsk, rounds);
}

// ── whole quote ─────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {object} p.pkg               package row
 * @param {object[]} p.pricingRules
 * @param {object[]} p.negotiationRules
 * @param {object[]} p.slabs
 * @param {object} [p.galleryItem]     the photo the customer chose (its price range is the design price)
 * @param {Array<{pkg:object, quantity?:number, rules?:object[]}>} [p.addons]
 * @param {number|null} [p.km]         road distance from base; null = not known yet
 */
function buildQuote({
  pkg, pricingRules = [], negotiationRules = [], slabs = [], themeId = null, occasionId = null,
  galleryItem = null, addons = [], km = null, maxServiceKm = null, onDate = null,
}) {
  const base = resolveBasePrice({ pkg, rules: pricingRules, themeId, occasionId, galleryItem, onDate });
  if (!base) return { ok: false, reason: 'no_price', package_id: pkg.id };

  const lines = [];
  const unconfirmed = [];
  // Quote at the top of the design's range; the bottom of the range is not an automatic discount.
  const listPrice = base.max;
  lines.push({ kind: 'design', label: galleryItem?.title ? `${pkg.name} – ${galleryItem.title}` : pkg.name, amount: listPrice, range: [base.min, base.max], source: base.source });
  if (!base.confirmed) unconfirmed.push(base.source === 'gallery_item' ? 'photo price' : 'design price');

  let surcharge = 0;
  for (const r of pricingRules) {
    if (r.package_id === pkg.id && r.rule_type === 'surcharge' && ruleApplies(r, { themeId, occasionId, onDate })) {
      surcharge += rupees(r.price_max);
      lines.push({ kind: 'surcharge', label: r.notes || 'Theme surcharge', amount: rupees(r.price_max), rule_id: r.id });
      if (!r.price_confirmed) unconfirmed.push('extra charge');
    }
  }

  let addonsTotal = 0;
  for (const a of addons) {
    const qty = Math.max(1, Math.floor(Number(a.quantity || 1)));
    const ab = resolveBasePrice({ pkg: a.pkg, rules: a.rules || pricingRules, themeId, occasionId, onDate });
    if (!ab) return { ok: false, reason: 'addon_no_price', package_id: a.pkg.id };
    if (a.pkg.kind === 'unit' && a.pkg.min_quantity && qty < a.pkg.min_quantity) {
      return { ok: false, reason: 'below_min_quantity', package_id: a.pkg.id, min_quantity: a.pkg.min_quantity };
    }
    const amount = ab.max * qty;
    addonsTotal += amount;
    lines.push({ kind: 'addon', label: qty > 1 ? `${a.pkg.name} × ${qty}` : a.pkg.name, amount, unit_price: ab.max, quantity: qty, package_id: a.pkg.id });
    if (!ab.confirmed) unconfirmed.push(`${a.pkg.name} price`);
  }

  let distance = null;
  let distanceTotal = 0;
  if (km != null) {
    distance = distanceCharge(km, slabs, { maxServiceKm });
    if (distance.serviceable) {
      distanceTotal = distance.charge;
      lines.push({ kind: 'distance', label: distance.label || `Travel (${distance.km} km)`, amount: distanceTotal, km: distance.km });
      if (distance.slab && !distance.slab.price_confirmed) unconfirmed.push('distance charge');
    }
  }

  const designPrice = listPrice + surcharge;
  const rule = pickNegotiationRule(negotiationRules, { packageId: pkg.id, themeId });
  const { full, floor, maxDiscount } = computeFloor({ listPrice: designPrice, addonsTotal, distanceCharge: distanceTotal, rule });
  if (rule && !rule.price_confirmed && rule.notes && /TODO/i.test(rule.notes)) unconfirmed.push('negotiation limits');

  return {
    ok: true,
    package_id: pkg.id,
    pricing_rule_id: base.rule_id,
    negotiation_rule_id: rule ? rule.id : null,
    design_range: [base.min, base.max],
    list_price: designPrice,
    addons_total: addonsTotal,
    distance_charge: distanceTotal,
    distance,
    serviceable: distance ? distance.serviceable : null,
    full_price: full,
    floor_price: floor,
    max_discount: maxDiscount,
    max_rounds: rule ? Number(rule.max_rounds) : 0,
    line_items: lines,
    unconfirmed,
  };
}

module.exports = { distanceCharge, resolveBasePrice, pickNegotiationRule, computeFloor, negotiate, buildQuote };
