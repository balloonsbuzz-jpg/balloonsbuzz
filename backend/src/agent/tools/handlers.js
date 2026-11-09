// Tool implementations. Each handler gets (args, ctx) and returns a JSON-able result
// for the model. Handlers that decide a person must take over set ctx.handover;
// the runtime then switches the chat (the model can't talk its way past it).
const { query, withTx } = require('../../db/pool');
const { env } = require('../../config/env');
const gallery = require('../../gallery/gallery.service');
const pricing = require('../../pricing/pricing.service');
const engine = require('../../pricing/engine');
const { distanceFromBase } = require('../../pricing/distance');
const { enqueueMessage } = require('../../whatsapp/outbound.service');
const { enqueue } = require('../../queue/jobs');
const { checkPrices } = require('../guard');
const leads = require('../leads');

const inr = (v) => `₹${Math.round(Number(v)).toLocaleString('en-IN')}`;

/** Bot message from inside a tool (photos, location request). */
async function sendFromTool(ctx, type, content, extra = {}) {
  return enqueueMessage({
    tenantId: ctx.tenantId, conversationId: ctx.conversationId, type, content, senderType: 'bot',
    aiRunId: ctx.runId, delayMs: ctx.nextDelay(), ...extra,
  });
}

async function resolvePkg(tenantId, key) {
  if (!key) return null;
  return gallery.resolvePackage(tenantId, key);
}

// ── get_pricing ─────────────────────────────────────────────────
async function getPricing(a, ctx) {
  const lead = await leads.getOrCreate(ctx.tenantId, ctx.conversationId);
  let item = null;
  if (a.photo_id) {
    const { rows: [r] } = await query(`SELECT id, title, package_id, theme_id FROM gallery_items WHERE id = $1 AND tenant_id = $2`, [a.photo_id, ctx.tenantId]);
    if (!r) return { error: 'Unknown photo_id. Use an id from the photos already sent (see context).' };
    item = r;
  }
  const pkg = item ? null : await resolvePkg(ctx.tenantId, a.package_key);
  if (!item && !pkg) return { error: `Unknown package_key "${a.package_key}". Use a key from the design categories in the context.` };

  const theme = a.theme ? await gallery.resolveTheme(ctx.tenantId, a.theme) : null;
  const occasion = a.occasion ? await gallery.resolveOccasion(ctx.tenantId, a.occasion) : null;
  const addons = [];
  for (const ad of a.addons || []) {
    const p = await resolvePkg(ctx.tenantId, ad.package_key);
    if (!p || p.kind === 'package') return { error: `Unknown add-on "${ad.package_key}"` };
    addons.push({ package_id: p.id, quantity: ad.quantity });
  }

  const q = await pricing.quote({
    tenantId: ctx.tenantId, packageId: pkg?.id, galleryItemId: item?.id,
    themeId: theme?.id || lead.theme_id || null, occasionId: occasion?.id || lead.occasion_id || null,
    addons, km: lead.distance_km != null ? Number(lead.distance_km) : null, eventDate: lead.event_date || null,
  });
  if (!q.ok) {
    return {
      available: false, reason: q.reason,
      instruction: q.reason === 'below_min_quantity' ? `Minimum quantity is ${q.min_quantity}.`
        : 'There is no price set for this. Do not guess: tell the customer the team will share the price, and call handover_to_human.',
    };
  }

  const quote = await withTx(async (c) => {
    await c.query(
      `UPDATE quotes SET status = 'superseded' WHERE conversation_id = $1 AND package_id = $2
          AND gallery_item_id IS NOT DISTINCT FROM $3 AND status IN ('issued','negotiating')`, [ctx.conversationId, q.package_id, item?.id || null]);
    const { rows: [row] } = await c.query(
      `INSERT INTO quotes (tenant_id, lead_id, conversation_id, package_id, theme_id, gallery_item_id, pricing_rule_id, negotiation_rule_id,
                           list_price, addons_total, distance_charge, discount_amount, final_price, floor_price, line_items, valid_until, created_by_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,$14, now() + interval '7 days','bot') RETURNING id`,
      [ctx.tenantId, lead.id, ctx.conversationId, q.package_id, theme?.id || lead.theme_id || item?.theme_id || null, item?.id || null,
        q.pricing_rule_id, q.negotiation_rule_id, q.list_price, q.addons_total, q.distance_charge, q.full_price, q.floor_price, JSON.stringify(q.line_items)]);
    await c.query(
      `INSERT INTO quote_events (tenant_id, quote_id, conversation_id, event_type, offered_price, actor_type, metadata)
       VALUES ($1,$2,$3,'issued',$4,'bot',$5)`, [ctx.tenantId, row.id, ctx.conversationId, q.full_price, JSON.stringify({ run_id: ctx.runId })]);
    await c.query(`UPDATE leads SET package_id = $2, status = CASE WHEN status IN ('new','qualifying') THEN 'quoted' ELSE status END, last_activity_at = now() WHERE id = $1`,
      [lead.id, q.package_id]);
    return row;
  });

  return {
    quote_id: quote.id,
    design: item?.title ? `${q.package.name} – ${item.title}` : q.package.name,
    design_price_range: q.design_range,
    price_items: q.line_items.map((l) => ({ item: l.label, amount: l.amount })),
    travel: q.distance ? (q.distance.serviceable ? { km: q.distance.km, charge: q.distance_charge } : 'outside the service area') : 'not known yet: ask for the venue location',
    total_price: q.full_price,
    can_discount: q.floor_price < q.full_price,
    note: q.unconfirmed.length ? 'Some prices are estimates; say "approx." and that the team confirms the final amount.' : undefined,
  };
}

// ── send_photos ─────────────────────────────────────────────────
async function sendPhotos(a, ctx) {
  const cfg = ctx.toolConfig.send_photos || {};
  const lead = await leads.get(ctx.conversationId);
  const { rows: sent } = await query(`SELECT DISTINCT gallery_item_id FROM messages WHERE conversation_id = $1 AND gallery_item_id IS NOT NULL`, [ctx.conversationId]);
  const limit = Math.min(a.count || cfg.default_count || 3, cfg.max_count || 5);
  // Models often put a design category in `theme` ("ring frame"): use it as the category.
  let { theme } = a;
  let packageRef = a.package_key;
  if (theme && !(await gallery.resolveTheme(ctx.tenantId, theme))) {
    const p = await gallery.resolvePackage(ctx.tenantId, theme);
    if (p) { packageRef = packageRef || p.key; theme = undefined; }
  }
  const r = await gallery.searchPhotos({
    tenantId: ctx.tenantId,
    theme: theme || (a.theme ? undefined : lead?.theme_name) || undefined,
    occasion: a.occasion || lead?.occasion_name || undefined,
    packageRef: packageRef || (lead?.package_id && !theme ? lead.package_id : undefined),
    budgetMin: a.budget_min ?? (lead?.budget_min != null ? Number(lead.budget_min) : null),
    budgetMax: a.budget_max ?? (lead?.budget_max != null ? Number(lead.budget_max) : null),
    style: a.style, excludeItemIds: sent.map((s) => s.gallery_item_id), limit,
    upsellPct: cfg.budget_upsell_pct ?? 15, spread: cfg.spread_across_packages ?? true,
  });
  for (const it of r.items) {
    await sendFromTool(ctx, 'image', { link: it.url, caption: it.caption }, { galleryItemId: it.id });
  }
  const notes = {
    cheaper: 'Nothing in the budget for this theme; these are the closest cheaper designs. Say so.',
    above_budget: 'Everything in this theme costs more than the budget; these are the cheapest. Say so kindly.',
    no_match: 'No photos for this combination. Tell the customer honestly and suggest one of the suggested themes.',
    unknown_theme: 'This theme is not in our gallery. Offer the suggested themes, or say the team can do custom designs (handover).',
  };
  return {
    sent: r.items.map((it) => ({ photo_id: it.id, title: it.title, category: it.package, price_range: [it.price_min, it.price_max], fit: it.fit })),
    already_sent_before: sent.length,
    note: r.fallback ? notes[r.fallback] : (r.items.length ? 'Photos are sent with their captions; do not repeat prices one by one, just ask which they like.' : 'No new photos left for this request.'),
    suggested_themes: r.suggestions?.map((s) => s.name),
  };
}

// ── distance ────────────────────────────────────────────────────
async function geocode(address) {
  if (!env.GOOGLE_MAPS_API_KEY) return null;
  const qs = new URLSearchParams({ address: `${address}, Hyderabad`, region: 'in', key: env.GOOGLE_MAPS_API_KEY });
  const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${qs}`, { signal: AbortSignal.timeout(8000) });
  const j = await res.json();
  const loc = j?.results?.[0]?.geometry?.location;
  return loc ? { lat: loc.lat, lng: loc.lng } : null;
}

async function calculateDistance(a, ctx) {
  const lead = await leads.getOrCreate(ctx.tenantId, ctx.conversationId);
  let loc = a.latitude != null && a.longitude != null ? { lat: a.latitude, lng: a.longitude } : null;
  if (!loc && a.address) loc = await geocode(a.address);
  if (!loc && lead.venue_lat != null) loc = { lat: Number(lead.venue_lat), lng: Number(lead.venue_lng) };
  if (!loc) return { need_location: true, instruction: 'Ask for the venue location pin: call request_location.' };

  let r;
  try {
    r = await pricing.distanceQuote({ tenantId: ctx.tenantId, location: loc });
  } catch (err) {
    if (err.status === 409) {
      ctx.handover = { trigger: 'system', reason: 'Travel charge needed but the base location is not set in Pricing & Rules' };
      return { error: 'Travel charge cannot be calculated right now. The team will confirm it.' };
    }
    throw err;
  }
  await query(
    `UPDATE leads SET venue_lat = $2, venue_lng = $3, venue_address = COALESCE($4, venue_address), distance_km = $5,
            distance_charge = $6, distance_method = $7, last_activity_at = now() WHERE id = $1`,
    [lead.id, loc.lat, loc.lng, a.address || null, r.km, r.serviceable ? r.charge : null, r.lookup?.method === 'google' ? 'google' : 'haversine']);
  if (!r.serviceable) {
    ctx.handover = { trigger: 'out_of_area', reason: `Venue is ${r.km} km away: outside the service area`, metadata: { km: r.km } };
    return { km: r.km, serviceable: false, instruction: 'Outside our usual area: the team will check and reply. Do not quote a travel charge.' };
  }
  return { km: r.km, serviceable: true, travel_charge: r.charge, band: r.label, note: 'Call get_pricing again so the quote includes travel.' };
}

// ── negotiation ─────────────────────────────────────────────────
async function checkNegotiation(a, ctx) {
  const { rows: [q] } = a.quote_id
    ? await query(`SELECT * FROM quotes WHERE id = $1 AND conversation_id = $2`, [a.quote_id, ctx.conversationId])
    : await query(`SELECT * FROM quotes WHERE conversation_id = $1 AND status IN ('issued','negotiating','accepted')
                    ORDER BY created_at DESC LIMIT 1`, [ctx.conversationId]);
  if (!q) return { error: 'No quote yet: call get_pricing first.' };
  if (['superseded', 'expired', 'escalated'].includes(q.status)) return { error: `That quote is ${q.status}; use the latest quote_id.` };

  const full = Number(q.list_price) + Number(q.addons_total) + Number(q.distance_charge);
  const floor = Number(q.floor_price);
  const currentAsk = Number(q.final_price);
  const { rows: [rule] } = q.negotiation_rule_id
    ? await query(`SELECT * FROM negotiation_rules WHERE id = $1`, [q.negotiation_rule_id]) : { rows: [null] };
  const r = engine.negotiate({ full, floor, offer: a.requested_price, currentAsk, roundsUsed: q.rounds_used, rule });

  // Already at our lowest and the customer still wants less: a person decides.
  const escalate = r.below_floor && r.decision === 'final_offer' && currentAsk === floor;
  const status = escalate ? 'escalated' : r.decision === 'accept' ? 'accepted' : 'negotiating';
  await withTx(async (c) => {
    await c.query(
      `UPDATE quotes SET final_price = $2, discount_amount = $3, rounds_used = $4, status = $5 WHERE id = $1`,
      [q.id, r.price, full - r.price, r.rounds_used, status]);
    await c.query(
      `INSERT INTO quote_events (tenant_id, quote_id, conversation_id, event_type, requested_price, offered_price, actor_type, metadata)
       VALUES ($1,$2,$3,'counter_request',$4,NULL,'customer','{}'), ($1,$2,$3,$5,$4,$6,'bot',$7)`,
      [ctx.tenantId, q.id, ctx.conversationId, a.requested_price,
        escalate ? 'escalated' : r.decision === 'accept' ? 'accepted' : 'counter_offer', r.price,
        JSON.stringify({ decision: r.decision, rounds_used: r.rounds_used, run_id: ctx.runId })]);
    await c.query(`UPDATE leads SET status = 'negotiating', last_activity_at = now() WHERE id = $1 AND status IN ('quoted','qualifying','new')`, [q.lead_id]);
  });

  if (escalate) {
    ctx.handover = {
      trigger: 'discount_limit', reason: `Customer wants ${inr(a.requested_price)}; lowest allowed is ${inr(floor)}`,
      metadata: { quote_id: q.id, requested_price: a.requested_price, floor_price: floor },
    };
    return { decision: 'escalate', instruction: 'A team member will reply about the price. Do not offer anything lower.' };
  }
  return {
    quote_id: q.id,
    decision: r.decision,                         // accept | counter | final_offer
    price: r.price,
    is_lowest: r.at_floor,
    instruction: r.decision === 'accept' ? `Agree to ${inr(r.price)}.`
      : r.decision === 'counter' ? `Offer ${inr(r.price)} warmly. Do not call it your best or final price, and do not go lower in this message.`
        : `${inr(r.price)} is the best price. Say so kindly; do not offer anything lower.`,
  };
}

// ── booking (full booking flow arrives in M7) ───────────────────
async function createBooking(a, ctx) {
  const parts = [a.event_date && `date ${a.event_date}`, a.event_time, a.venue_address && `venue ${a.venue_address}`, a.guest_count && `${a.guest_count} guests`, a.special_requests]
    .filter(Boolean).join(', ');
  ctx.handover = { trigger: 'system', reason: 'Customer is ready to book', summary: `Ready to book${parts ? `: ${parts}` : ''}`, metadata: { quote_id: a.quote_id || null } };
  return { status: 'handed_to_team', instruction: 'Tell the customer the team will confirm the booking and share the advance payment details here shortly.' };
}

// ── handover ────────────────────────────────────────────────────
function triggerFor(reason) {
  const r = reason.toLowerCase();
  if (/discount|price|cheaper|negotiat/.test(r)) return 'discount_limit';
  if (/area|distance|far|location/.test(r)) return 'out_of_area';
  if (/date|slot|available|booked/.test(r)) return 'date_unavailable';
  if (/person|human|team|call|speak|talk|agent|manager/.test(r)) return 'customer_request';
  return 'system';
}

async function handover(a, ctx) {
  ctx.handover = { trigger: triggerFor(a.reason), reason: a.reason, summary: a.summary };
  return { status: 'handed_over', instruction: 'Stop here; the team takes over this chat.' };
}

async function requestLocation(a, ctx) {
  const text = a.prompt_text || ctx.toolConfig.request_location?.default_prompt_text || 'Please share the venue location 📍';
  await sendFromTool(ctx, 'location_request', { text });
  return { sent: true, note: 'The location button is sent; wait for the pin.' };
}

async function updateLead(a, ctx) {
  const l = await leads.update(ctx.tenantId, ctx.conversationId, a);
  return { saved: Object.keys(a), still_missing: leads.missingFields(l) };
}

// ── follow-ups ──────────────────────────────────────────────────
function inQuietHours(date, [from, to]) {
  const ist = new Date(date.getTime() + 330 * 60_000);
  const hm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return m(from) > m(to) ? hm >= m(from) || hm < m(to) : hm >= m(from) && hm < m(to);
}

async function scheduleFollowup(a, ctx) {
  const cfg = ctx.toolConfig.schedule_followup || { max_days_ahead: 30, quiet_hours: ['21:30', '08:30'] };
  let at = new Date(a.send_at);
  if (Number.isNaN(at.getTime())) return { error: 'send_at must be an ISO date-time' };
  const now = Date.now();
  if (at.getTime() < now + 10 * 60_000) return { error: 'Pick a time at least 10 minutes from now' };
  if (at.getTime() > now + cfg.max_days_ahead * 86_400_000) return { error: `At most ${cfg.max_days_ahead} days ahead` };
  // never at night: move to the end of quiet hours (IST)
  for (let i = 0; i < 48 && inQuietHours(at, cfg.quiet_hours); i += 1) at = new Date(at.getTime() + 30 * 60_000);
  const guard = checkPrices(a.message, ctx.allowed);
  if (!guard.ok) return { error: `The follow-up mentions prices no tool issued (${guard.unknown.join(', ')}). Remove them.` };

  const { rows: [conv] } = await query(`SELECT contact_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  const lead = await leads.get(ctx.conversationId);
  const { rows: [f] } = await query(
    `INSERT INTO followups (tenant_id, contact_id, conversation_id, lead_id, kind, idempotency_key, scheduled_at, content)
     VALUES ($1,$2,$3,$4,'bot_scheduled',$5,$6,$7) RETURNING id, scheduled_at`,
    [ctx.tenantId, conv.contact_id, ctx.conversationId, lead?.id || null, `bot:${ctx.conversationId}:${at.toISOString()}`, at, JSON.stringify({ type: 'text', text: a.message })]);
  await enqueue({ tenantId: ctx.tenantId, name: 'send_followup', payload: { followup_id: f.id }, runAt: at, uniqueKey: `followup:${f.id}` });
  return { scheduled_for: f.scheduled_at, note: 'It is cancelled automatically if the customer replies first.' };
}

const HANDLERS = {
  get_pricing: getPricing,
  send_photos: sendPhotos,
  calculate_distance_charge: calculateDistance,
  check_negotiation_limit: checkNegotiation,
  create_booking: createBooking,
  handover_to_human: handover,
  request_location: requestLocation,
  update_lead: updateLead,
  schedule_followup: scheduleFollowup,
};

module.exports = { HANDLERS, triggerFor, inQuietHours };
