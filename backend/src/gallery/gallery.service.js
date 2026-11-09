// Gallery for admins (browse, fix names/prices, hide) and the bot's photo picker.
const { query } = require('../db/pool');
const { badRequest, notFound } = require('../lib/errors');
const { matchAlias, normaliseForMatch } = require('./names');
const { loadCatalogContext } = require('./importer');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── catalogue lookups (customer words -> ids), cached briefly ───
const ctxCache = new Map();
async function catalogContext(tenantId) {
  const hit = ctxCache.get(tenantId);
  if (hit && hit.at > Date.now() - 60_000) return hit.ctx;
  const ctx = await loadCatalogContext(tenantId);
  ctxCache.set(tenantId, { ctx, at: Date.now() });
  return ctx;
}
function invalidateCatalog(tenantId) { ctxCache.delete(tenantId); }

/** "dino", "Spider man", a theme key or id -> {id, key, name} | null */
async function resolveTheme(tenantId, text) {
  if (!text) return null;
  if (UUID_RE.test(text)) {
    const { rows: [t] } = await query(`SELECT id, key, name FROM themes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [text, tenantId]);
    return t || null;
  }
  const ctx = await catalogContext(tenantId);
  const byKey = ctx.themeAliases.find((a) => a.key === String(text).toLowerCase());
  return byKey ? { id: byKey.id, key: byKey.key, name: byKey.name } : (matchAlias(text, ctx.themeAliases) || null);
}

async function resolveOccasion(tenantId, text) {
  if (!text) return null;
  const ctx = await catalogContext(tenantId);
  if (UUID_RE.test(text)) return ctx.occasionAliases.find((a) => a.id === text) || null;
  return ctx.occasionAliases.find((a) => a.key === String(text).toLowerCase()) || matchAlias(text, ctx.occasionAliases) || null;
}

// Customer words for design categories: "two frames", "double frame", "3 frame", "ring".
const NUMBER_WORDS = [[/\b(two|double|dual)\b/g, '2'], [/\b(three|triple)\b/g, '3'], [/\b(four|more than 3|more then 3)\b/g, '4'], [/\bone\b/g, 'single']];
function packageWords(text) {
  let s = normaliseForMatch(text).replace(/\bframes\b/g, 'frame').replace(/\bdecor(ation)?s?\b/g, '').replace(/\btheme\b/g, '');
  for (const [re, to] of NUMBER_WORDS) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}

async function resolvePackage(tenantId, text) {
  if (!text) return null;
  const raw = String(text).trim();
  const { rows } = await query(
    `SELECT id, key, name, kind, folder_names FROM packages WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active ORDER BY sort_order`, [tenantId]);
  const exact = rows.find((p) => p.id === raw || p.key === raw.toLowerCase() || p.name.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const want = packageWords(raw);
  if (!want) return null;
  const labels = (p) => [p.name, p.key.replace(/_/g, ' '), ...(p.folder_names || []).map((f) => f.split('/').pop())]
    .map(packageWords).filter(Boolean);
  // exact label ("2 frame" == "2 frames decor"), then the shortest label contained in the request ("ring" in "ring frame please")
  const byLabel = rows.find((p) => labels(p).includes(want))
    || rows.map((p) => ({ p, hit: labels(p).filter((l) => ` ${want} `.includes(` ${l} `)).sort((a, b) => b.length - a.length)[0] }))
      .filter((x) => x.hit).sort((a, b) => b.hit.length - a.hit.length)[0]?.p;
  if (byLabel) return byLabel;
  // a single word that only one category uses ("ring", "sequin"); "arch" or "frame" stay ambiguous
  const owners = rows.filter((p) => labels(p).some((l) => ` ${l} `.includes(` ${want} `)));
  return owners.length === 1 ? owners[0] : null;
}

// ── admin list ──────────────────────────────────────────────────
const STATUS_FILTERS = {
  all: 'i.is_present_in_source',
  sendable: 'i.is_sendable',
  needs_price: `i.is_present_in_source AND NOT i.override_hidden AND (i.name_quality <> 'generic' OR i.override_force_sendable) AND i.price_min IS NULL`,
  generic: `i.is_present_in_source AND NOT i.override_hidden AND i.name_quality = 'generic' AND NOT i.override_force_sendable`,
  hidden: 'i.is_present_in_source AND i.override_hidden',
  removed: 'NOT i.is_present_in_source',
};

const ITEM_SELECT = `
  SELECT i.id, i.source, i.source_path, i.title, i.parsed_title, i.name_quality, i.parsed_style AS style,
         i.price_min, i.price_max, i.parsed_price_min, i.parsed_price_max, i.parsed_price_source,
         i.package_id, i.theme_id, i.occasion_id, i.parsed_package_id, i.parsed_theme_id, i.parsed_occasion_id,
         i.override_title, i.override_package_id, i.override_theme_id, i.override_occasion_id,
         i.override_price_min, i.override_price_max, i.override_hidden, i.override_force_sendable, i.override_updated_at,
         i.is_present_in_source, i.is_sendable, i.last_synced_at, i.created_at,
         a.id AS asset_id, a.public_url AS url, COALESCE(a.thumb_url, a.public_url) AS thumb_url, a.width, a.height, a.size_bytes,
         p.name AS package_name, p.key AS package_key, t.name AS theme_name, t.key AS theme_key, o.name AS occasion_name, o.key AS occasion_key
    FROM gallery_items i
    JOIN gallery_assets a ON a.id = i.asset_id
    LEFT JOIN packages p ON p.id = i.package_id
    LEFT JOIN themes t ON t.id = i.theme_id
    LEFT JOIN occasions o ON o.id = i.occasion_id`;

async function list(tenantId, { status = 'all', q, packageId, themeId, limit = 60, offset = 0 }) {
  const where = ['i.tenant_id = $1', STATUS_FILTERS[status] || STATUS_FILTERS.all];
  const params = [tenantId];
  if (q) { params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(i.title ILIKE $${params.length} OR i.source_path ILIKE $${params.length})`); }
  if (packageId) { params.push(packageId); where.push(`i.package_id = $${params.length}`); }
  if (themeId) { params.push(themeId); where.push(`i.theme_id = $${params.length}`); }
  const whereSql = where.join(' AND ');
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    query(`${ITEM_SELECT} WHERE ${whereSql} ORDER BY p.sort_order NULLS LAST, t.name NULLS LAST, i.price_min NULLS LAST, i.source_path
           LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params),
    query(`SELECT count(*)::int AS total FROM gallery_items i WHERE ${whereSql}`, params),
  ]);
  return { items: rows, total };
}

async function stats(tenantId) {
  const sel = Object.entries(STATUS_FILTERS).map(([k, sql]) => `count(*) FILTER (WHERE ${sql})::int AS ${k}`).join(', ');
  const { rows: [r] } = await query(`SELECT ${sel} FROM gallery_items i WHERE i.tenant_id = $1`, [tenantId]);
  return r;
}

async function get(tenantId, id) {
  const { rows: [r] } = await query(`${ITEM_SELECT} WHERE i.tenant_id = $1 AND i.id = $2`, [tenantId, id]);
  if (!r) throw notFound('Photo not found');
  return r;
}

/** Admin overrides. `null` clears an override (falls back to what was parsed from Drive). */
async function updateOverrides(tenantId, id, userId, patch) {
  const before = await get(tenantId, id);
  const refs = [['override_package_id', 'packages'], ['override_theme_id', 'themes'], ['override_occasion_id', 'occasions']];
  for (const [field, table] of refs) {
    if (patch[field]) {
      const { rowCount } = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [patch[field], tenantId]);
      if (!rowCount) throw badRequest(`Unknown ${table.slice(0, -1)}`);
    }
  }
  const min = 'override_price_min' in patch ? patch.override_price_min : before.override_price_min;
  const max = 'override_price_max' in patch ? patch.override_price_max : before.override_price_max;
  if ((min == null) !== (max == null)) throw badRequest('Set both the minimum and maximum price, or clear both');
  if (min != null && Number(max) < Number(min)) throw badRequest('Maximum price must be at least the minimum');

  const fields = Object.keys(patch);
  if (!fields.length) return before;
  await query(
    `UPDATE gallery_items SET ${fields.map((f, i) => `${f} = $${i + 3}`).join(', ')},
            override_updated_by = $2, override_updated_at = now()
      WHERE id = $1`, [id, userId, ...fields.map((f) => patch[f])]);
  return { before, after: await get(tenantId, id) };
}

// ── the bot's photo picker ──────────────────────────────────────
const inr = (v) => `₹${Number(v).toLocaleString('en-IN')}`;
function priceLabel(min, max) {
  return Number(min) === Number(max) ? inr(min) : `${inr(min)} – ${inr(max)}`;
}

function caption(it) {
  const name = it.title && it.package_name && !it.title.toLowerCase().includes(it.package_name.toLowerCase())
    ? `${it.title} · ${it.package_name}` : (it.title || it.package_name || 'Decor');
  return `${name}\n${priceLabel(it.price_min, it.price_max)} (estimate)`;
}

/**
 * Picks photos for a customer request. Never returns photos that aren't sendable
 * (generic names, no price, hidden, removed from Drive).
 *
 * Scoring (see docs/gallery-catalog.md): theme +5, occasion +3, price range overlaps
 * the budget +4, slightly above budget (≤ upsell %) +1, style +1.
 * Items far above the budget are never sent; if nothing fits, the cheapest in the
 * theme is offered with fallback='above_budget'.
 */
async function searchPhotos({
  tenantId, theme, occasion, packageRef, budgetMin = null, budgetMax = null, style = null,
  excludeItemIds = [], limit = 3, upsellPct = 15, spread = true,
}) {
  const [th, occ, pkg] = await Promise.all([
    theme ? resolveTheme(tenantId, theme) : null,
    occasion ? resolveOccasion(tenantId, occasion) : null,
    packageRef ? resolvePackage(tenantId, packageRef) : null,
  ]);
  const match = { theme: th ? th.name : null, occasion: occ ? occ.name : null, package: pkg ? pkg.name : null };
  if (theme && !th) return { items: [], match, fallback: 'unknown_theme', suggestions: await themesInBudget(tenantId, budgetMin, budgetMax) };

  let bMin = budgetMin == null ? null : Number(budgetMin);
  let bMax = budgetMax == null ? null : Number(budgetMax);
  if (bMin != null && bMax == null) bMax = bMin;
  if (bMax != null && bMin == null) bMin = 0;
  if (bMin != null && bMin > bMax) [bMin, bMax] = [bMax, bMin];

  const { rows } = await query(
    `${ITEM_SELECT}
      WHERE i.tenant_id = $1 AND i.is_sendable
        AND ($2::uuid IS NULL OR i.theme_id = $2)
        AND ($3::uuid IS NULL OR i.package_id = $3)
        AND NOT (i.id = ANY($4::uuid[]))
        AND i.asset_id NOT IN (SELECT asset_id FROM gallery_items WHERE id = ANY($4::uuid[]))`,
    [tenantId, th ? th.id : null, pkg ? pkg.id : null, excludeItemIds]);

  if (!rows.length) {
    return { items: [], match, fallback: 'no_match', suggestions: await themesInBudget(tenantId, bMin, bMax, pkg ? pkg.id : null) };
  }

  const scored = [];
  for (const it of rows) {
    const pMin = Number(it.price_min); const pMax = Number(it.price_max);
    let score = 0; const reasons = []; let fit = 'no_budget';
    if (th) { score += 5; reasons.push('theme'); }
    if (occ && it.occasion_id === occ.id) { score += 3; reasons.push('occasion'); }
    if (style && it.style === style) { score += 1; reasons.push('style'); }
    if (bMax != null) {
      if (pMin <= bMax && pMax >= bMin) { score += 4; fit = 'in_budget'; reasons.push('budget'); }
      else if (pMin > bMax && pMin <= bMax * (1 + upsellPct / 100)) { score += 1; fit = 'slightly_above'; }
      else if (pMax < bMin) { fit = 'cheaper'; }
      else fit = 'above_budget';
    }
    const distance = bMax == null ? 0 : Math.abs((pMin + pMax) / 2 - (bMin + bMax) / 2);
    scored.push({ ...it, score, reasons, fit, distance });
  }

  // In budget (and a gentle upsell) first; cheaper designs only when nothing fits;
  // the cheapest above-budget designs only when there is nothing cheaper either.
  let pool = scored.filter((s) => s.fit === 'in_budget' || s.fit === 'slightly_above' || s.fit === 'no_budget');
  let fallback = null;
  if (!pool.length) {
    pool = scored.filter((s) => s.fit === 'cheaper').sort((a, b) => Number(b.price_max) - Number(a.price_max));
    fallback = 'cheaper';
  }
  if (!pool.length) {
    pool = scored.sort((a, b) => Number(a.price_min) - Number(b.price_min));
    fallback = 'above_budget';
  }
  if (!fallback) pool.sort((a, b) => b.score - a.score || a.distance - b.distance || Number(a.price_min) - Number(b.price_min));

  // One photo per asset; spread across design categories (e.g. one single frame, one 2-frame, one ring).
  const seenAssets = new Set(); const picked = []; const seenPkgs = new Set();
  const uniq = pool.filter((p) => (seenAssets.has(p.asset_id) ? false : seenAssets.add(p.asset_id)));
  if (spread && !pkg) {
    for (const p of uniq) {
      if (picked.length >= limit) break;
      if (!seenPkgs.has(p.package_id)) { picked.push(p); seenPkgs.add(p.package_id); }
    }
  }
  for (const p of uniq) {
    if (picked.length >= limit) break;
    if (!picked.includes(p)) picked.push(p);
  }

  return {
    items: picked.map((p) => ({
      id: p.id, title: p.title, package: p.package_name, theme: p.theme_name, occasion: p.occasion_name, style: p.style,
      price_min: Number(p.price_min), price_max: Number(p.price_max), url: p.url, thumb_url: p.thumb_url,
      caption: caption(p), score: p.score, reasons: p.reasons, fit: p.fit,
    })),
    match,
    fallback,
    suggestions: [],
  };
}

/** Themes with sendable photos in a budget: what the bot offers when the asked-for theme has none. */
async function themesInBudget(tenantId, bMin, bMax, packageId = null) {
  const { rows } = await query(
    `SELECT t.name, count(*)::int AS photos, min(i.price_min)::int AS from_price
       FROM gallery_items i JOIN themes t ON t.id = i.theme_id
      WHERE i.tenant_id = $1 AND i.is_sendable
        AND ($2::numeric IS NULL OR i.price_min <= $2)
        AND ($3::numeric IS NULL OR i.price_max >= $3)
        AND ($4::uuid IS NULL OR i.package_id = $4)
      GROUP BY t.name ORDER BY count(*) DESC, t.name LIMIT 6`,
    [tenantId, bMax, bMin, packageId]);
  return rows;
}

module.exports = {
  list, stats, get, updateOverrides, searchPhotos, resolveTheme, resolveOccasion, resolvePackage,
  invalidateCatalog, caption, priceLabel,
};
