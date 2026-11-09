// Outbound guard + message splitting. Pure functions.
//
// "Never invent prices" as a code guarantee: every rupee amount in a bot reply must
// be an amount a pricing tool issued in this conversation. Anything else blocks the
// reply (the runtime asks the model to fix it once, then hands over to a person).

const NUM = '(\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.(\\d{1,2}))?';
// ₹12,000 · Rs. 12000 · INR 12,000 · ₹12k · ₹1.2 lakh, optionally a range "₹10,000 – 12,000" / "₹10-12k"
const CURRENCY_RE = new RegExp(
  `(?:₹|\\brs\\.?|\\binr)\\s*${NUM}\\s*(k|lakhs?|lacs?|l)?\\b(?:\\s*(?:-|–|—|to)\\s*(?:₹|rs\\.?|inr)?\\s*${NUM}\\s*(k|lakhs?|lacs?|l)?\\b)?`, 'gi');
// 12,000 rupees · 12000/- · 12k (k on its own is a price in this business)
const SUFFIX_RE = new RegExp(`(?<![\\d.,₹])${NUM}\\s*(?:(rupees|rs\\b|\\/-)|(k)\\b)`, 'gi');
const K_RANGE_RE = new RegExp(`(?<![\\d.,₹])${NUM}\\s*(?:-|–|—|to)\\s*${NUM}\\s*k\\b`, 'gi');

function toRupees(intPart, frac, unit) {
  let v = Number(String(intPart).replace(/,/g, '') + (frac ? `.${frac}` : ''));
  const u = (unit || '').toLowerCase();
  if (u === 'k') v *= 1000;
  else if (u.startsWith('l')) v *= 100000;
  return Math.round(v);
}

/** All rupee amounts mentioned in a text. */
function extractAmounts(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(CURRENCY_RE)) {
    // "₹10-12k": the unit on the second number applies to both
    const unitA = m[3] || (m[6] && !m[3] ? m[6] : '');
    out.add(toRupees(m[1], m[2], unitA));
    if (m[4]) out.add(toRupees(m[4], m[5], m[6]));
  }
  for (const m of s.matchAll(K_RANGE_RE)) {
    out.add(toRupees(m[1], m[2], 'k'));
    out.add(toRupees(m[3], m[4], 'k'));
  }
  for (const m of s.matchAll(SUFFIX_RE)) out.add(toRupees(m[1], m[2], m[4] ? 'k' : ''));
  return [...out].filter((v) => Number.isFinite(v) && v > 0);
}

/**
 * @param {string} text the reply the model wants to send
 * @param {Set<number>|number[]} allowed amounts issued by tools in this conversation
 * @returns {{ok:boolean, unknown:number[]}}
 */
function checkPrices(text, allowed) {
  const ok = allowed instanceof Set ? allowed : new Set(allowed);
  const unknown = extractAmounts(text).filter((v) => !ok.has(v));
  return { ok: unknown.length === 0, unknown };
}

/** Every money-like number in a tool result (prices, charges, ranges), so the model may repeat them. */
function amountsInResult(value, out = new Set(), key = '') {
  if (value == null) return out;
  if (typeof value === 'number') {
    if (/price|charge|amount|total|cost|floor|min|max|budget|range|offer|ask/i.test(key) && value > 0) out.add(Math.round(value));
    return out;
  }
  if (typeof value === 'string') {
    for (const v of extractAmounts(value)) out.add(v);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) amountsInResult(v, out, key);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) amountsInResult(v, out, k);
  }
  return out;
}

/**
 * Splits a reply into WhatsApp-sized messages: paragraphs first, then sentences,
 * then words. Every part is at most `max` characters.
 */
function splitMessage(text, max = 300) {
  const clean = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const pieces = [];
  for (const para of clean.split(/\n\s*\n/)) {
    if (para.length <= max) { pieces.push(para.trim()); continue; }
    // keep list lines together where possible
    const sentences = para.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g) || [para];
    for (const sRaw of sentences) {
      const sen = sRaw.trim();
      if (!sen) continue;
      if (sen.length <= max) { pieces.push(sen); continue; }
      let line = '';
      for (const w of sen.split(/\s+/)) {
        if (w.length > max) {                       // a single huge token (URL): hard cut
          if (line) { pieces.push(line); line = ''; }
          for (let i = 0; i < w.length; i += max) pieces.push(w.slice(i, i + max));
          continue;
        }
        if ((line ? `${line} ${w}` : w).length > max) { pieces.push(line); line = w; } else line = line ? `${line} ${w}` : w;
      }
      if (line) pieces.push(line);
    }
  }
  // greedily pack small pieces back together
  const parts = [];
  for (const p of pieces) {
    const last = parts[parts.length - 1];
    const sep = p.startsWith('-') || p.startsWith('•') || /^\d+[.)]/.test(p) ? '\n' : ' ';
    if (last && `${last}${sep}${p}`.length <= max) parts[parts.length - 1] = `${last}${sep}${p}`;
    else parts.push(p);
  }
  return parts;
}

/**
 * Removes internal notation the model sometimes echoes from the history or tools:
 * "[Photo sent: …]", "(photo_id …)", raw ids. Customers must never see these.
 */
function stripInternal(text) {
  return String(text || '')
    .replace(/\[(?:Photo sent|Sent to the customer|Customer (?:shared|sent)[^\]]*|Tapped|Voice note|Template message|Buttons sent)[^\]]*\]/gi, '')
    .replace(/\(?(?:photo_id|quote_id)\s*:?\s*[0-9a-f-]{36}\)?/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\(BalloonsBuzz team member wrote:\)\s*/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

module.exports = { extractAmounts, checkPrices, amountsInResult, splitMessage, stripInternal };
