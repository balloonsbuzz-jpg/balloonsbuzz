// WhatsApp template variables: Meta templates use numbered placeholders ({{1}}, {{2}}…);
// each template's variable_map says which of our fields fills each number.
const inr = (v) => (v == null ? '' : `₹${Math.round(Number(v)).toLocaleString('en-IN')}`);

/** Fields an admin can map a {{n}} to. */
const VARIABLES = [
  ['contact.name', 'Customer name', 'Kavya'],
  ['contact.first_name', 'Customer first name', 'Kavya'],
  ['contact.phone', 'Customer phone', '+91 90000 00001'],
  ['handover.reason', 'Why a person is needed', 'Customer asked for a person'],
  ['business.name', 'Business name', 'BalloonsBuzz'],
  ['booking.code', 'Booking code', 'BB-1001'],
  ['booking.event_date', 'Event date', '20 Dec 2026'],
  ['booking.event_time', 'Event time', '5:30 pm'],
  ['booking.venue', 'Venue', 'Kondapur'],
  ['booking.design', 'Design', '2 Frames Decor'],
  ['booking.agreed_price', 'Agreed price', '₹12,000'],
  ['booking.advance_amount', 'Advance required', '₹3,600'],
  ['booking.advance_paid', 'Advance paid', '₹3,600'],
  ['booking.advance_due', 'Advance still due', '₹3,600'],
  ['booking.balance', 'Balance on the day', '₹8,400'],
  ['payment.upi_id', 'UPI ID', 'balloonsbuzz@okhdfc'],
  ['static', 'Fixed text (typed per broadcast)', ''],
];
const VARIABLE_KEYS = new Set(VARIABLES.map(([k]) => k));

function prettyDate(d) {
  if (!d) return '';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function prettyTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** Values for every variable we know, from whatever context is available. */
function values({ contact = {}, booking = null, business = {}, handover = null } = {}) {
  const name = contact.name || '';
  const v = {
    'contact.name': name || 'there',
    'contact.first_name': name ? name.split(/\s+/)[0] : 'there',
    'contact.phone': contact.phone ? `+${contact.phone}` : '',
    'handover.reason': handover?.reason || '',
    'business.name': business.business_name || 'BalloonsBuzz',
    'payment.upi_id': business.upi_vpa || '',
  };
  if (booking) {
    const paid = Number(booking.advance_paid_amount || 0);
    Object.assign(v, {
      'booking.code': booking.booking_code,
      'booking.event_date': prettyDate(booking.event_date),
      'booking.event_time': prettyTime(booking.event_time),
      'booking.venue': booking.venue_address,
      'booking.design': booking.package_name || '',
      'booking.agreed_price': inr(booking.agreed_price),
      'booking.advance_amount': inr(booking.advance_amount),
      'booking.advance_paid': inr(paid),
      'booking.advance_due': inr(Math.max(0, Number(booking.advance_amount) - paid)),
      'booking.balance': inr(Number(booking.agreed_price) - paid),
    });
  }
  return v;
}

/** Placeholder numbers used in a template's BODY, e.g. [1, 2, 3]. */
function placeholders(components = []) {
  const body = (components || []).find((c) => c.type === 'BODY');
  const nums = new Set([...String(body?.text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])));
  return [...nums].sort((a, b) => a - b);
}

/**
 * Send content for a template.
 * @param {object} tpl {name, language, components, variable_map}
 * @param {object} vals from values()
 * @param {object} [statics] {"2": "Diwali 20% off"} for 'static' mappings (broadcasts)
 * @returns {{content:{name,language,components}, missing:string[]}}
 */
function buildContent(tpl, vals, statics = {}) {
  const map = tpl.variable_map || {};
  const missing = [];
  const params = placeholders(tpl.components).map((n) => {
    const key = map[String(n)];
    let text = key === 'static' ? statics[String(n)] : vals[key];
    if (text == null || String(text).trim() === '') { missing.push(`{{${n}}}${key ? ` (${key})` : ''}`); text = '-'; }
    return { type: 'text', text: String(text).slice(0, 1024) };
  });
  return {
    content: { name: tpl.name, language: tpl.language, components: params.length ? [{ type: 'body', parameters: params }] : [] },
    missing,
  };
}

/** Body text with placeholders filled, for previews and the inbox. */
function preview(tpl, vals = {}, statics = {}) {
  const body = (tpl.components || []).find((c) => c.type === 'BODY')?.text || '';
  const map = tpl.variable_map || {};
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n) => {
    const key = map[n];
    const v = key === 'static' ? statics[n] : vals[key];
    return v || VARIABLES.find(([k]) => k === key)?.[2] || all;
  });
}

module.exports = { VARIABLES, VARIABLE_KEYS, values, placeholders, buildContent, preview, prettyDate, prettyTime };
