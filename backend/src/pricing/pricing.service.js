// Loads pricing data from the DB and runs the pure quote engine.
// These are the functions the AI tools call in M6 (get_pricing, calculate_distance_charge,
// check_negotiation_limit) and the "Quote calculator" in the dashboard uses today.
const { query } = require('../db/pool');
const { badRequest, notFound } = require('../lib/errors');
const engine = require('./engine');
const { distanceFromBase } = require('./distance');

async function loadData(tenantId) {
  const [packages, pricingRules, negotiationRules, slabs, settings] = await Promise.all([
    query(`SELECT * FROM packages WHERE tenant_id = $1 AND deleted_at IS NULL`, [tenantId]),
    query(`SELECT * FROM pricing_rules WHERE tenant_id = $1 AND is_active`, [tenantId]),
    query(`SELECT * FROM negotiation_rules WHERE tenant_id = $1 AND is_active`, [tenantId]),
    query(`SELECT * FROM distance_slabs WHERE tenant_id = $1 AND is_active ORDER BY min_km`, [tenantId]),
    query(`SELECT max_service_km FROM business_settings WHERE tenant_id = $1`, [tenantId]),
  ]);
  return {
    packages: new Map(packages.rows.map((p) => [p.id, p])),
    pricingRules: pricingRules.rows,
    negotiationRules: negotiationRules.rows,
    slabs: slabs.rows,
    maxServiceKm: settings.rows[0]?.max_service_km ?? null,
  };
}

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} [p.packageId]       required unless galleryItemId is given
 * @param {string} [p.galleryItemId]   the photo the customer picked: sets the design price, package and theme
 * @param {string} [p.themeId]
 * @param {string} [p.occasionId]
 * @param {Array<{package_id:string, quantity?:number}>} [p.addons]
 * @param {number} [p.km]              road km, if already known
 * @param {{lat:number,lng:number}} [p.location]  venue pin (WhatsApp location message)
 * @param {string} [p.eventDate]       YYYY-MM-DD, for date-bound pricing rules
 */
async function quote({ tenantId, packageId, galleryItemId, themeId = null, occasionId = null, addons = [], km = null, location = null, eventDate = null }) {
  const data = await loadData(tenantId);
  let item = null;
  if (galleryItemId) {
    const { rows: [r] } = await query(
      `SELECT id, title, package_id, theme_id, occasion_id, price_min, price_max, is_sendable
         FROM gallery_items WHERE id = $1 AND tenant_id = $2`, [galleryItemId, tenantId]);
    if (!r) throw notFound('Photo not found');
    item = r;
  }
  const pkg = data.packages.get(packageId || item?.package_id);
  if (!pkg) throw badRequest('Choose a design category (package)');
  if (item && item.package_id && item.package_id !== pkg.id) throw badRequest('That photo belongs to a different design category');

  const addonRows = addons.map((a) => {
    const ap = data.packages.get(a.package_id);
    if (!ap || ap.kind === 'package') throw badRequest('Unknown add-on');
    return { pkg: ap, quantity: a.quantity };
  });

  let distanceInfo = null;
  let roadKm = km;
  if (roadKm == null && location) {
    distanceInfo = await distanceFromBase(tenantId, location);
    roadKm = distanceInfo.km;
  }

  const q = engine.buildQuote({
    pkg, pricingRules: data.pricingRules, negotiationRules: data.negotiationRules, slabs: data.slabs,
    themeId: themeId || item?.theme_id || null, occasionId: occasionId || item?.occasion_id || null,
    galleryItem: item && item.price_min != null ? item : null, addons: addonRows,
    km: roadKm, maxServiceKm: data.maxServiceKm, onDate: eventDate,
  });
  return { ...q, package: { id: pkg.id, key: pkg.key, name: pkg.name }, gallery_item_id: item?.id || null, distance_lookup: distanceInfo };
}

/**
 * One negotiation turn against the hard limits. The price returned is never below the floor.
 * @param {object} p  quote() input + offer, currentAsk, roundsUsed
 */
async function negotiateOffer({ offer, currentAsk = null, roundsUsed = 0, ...quoteInput }) {
  const q = await quote(quoteInput);
  if (!q.ok) return { ok: false, reason: q.reason, quote: q };
  const { rows: [rule] } = q.negotiation_rule_id
    ? await query(`SELECT * FROM negotiation_rules WHERE id = $1`, [q.negotiation_rule_id])
    : { rows: [null] };
  const result = engine.negotiate({ full: q.full_price, floor: q.floor_price, offer, currentAsk, roundsUsed, rule });
  return { ok: true, ...result, full_price: q.full_price, quote: q };
}

/** Distance charge only (customer shared a location before choosing a design). */
async function distanceQuote({ tenantId, km = null, location = null }) {
  const data = await loadData(tenantId);
  const lookup = km == null ? await distanceFromBase(tenantId, location) : null;
  const d = engine.distanceCharge(km ?? lookup.km, data.slabs, { maxServiceKm: data.maxServiceKm });
  return { ...d, slab: d.slab ? { id: d.slab.id, label: d.slab.label, charge_type: d.slab.charge_type } : null, lookup };
}

module.exports = { quote, negotiateOffer, distanceQuote, loadData };
