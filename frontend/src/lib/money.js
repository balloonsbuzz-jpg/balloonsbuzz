// Indian rupee formatting (₹1,23,456).
export const inr = (v) => (v == null || v === '' ? '—' : `₹${Math.round(Number(v)).toLocaleString('en-IN')}`);

export function priceRange(min, max) {
  if (min == null) return 'No price';
  return Number(min) === Number(max ?? min) ? inr(min) : `${inr(min)} – ${inr(max)}`;
}

/** "10k–12k" style, for tight spaces. */
export function priceShort(min, max) {
  if (min == null) return 'No price';
  const k = (v) => { const n = Number(v) / 1000; return `${Number.isInteger(n) ? n : n.toFixed(1)}k`; };
  return Number(min) === Number(max ?? min) ? `₹${k(min)}` : `₹${k(min)}–${k(max)}`;
}
