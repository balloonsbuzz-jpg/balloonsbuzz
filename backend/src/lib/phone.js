// Phone numbers are stored as digits-only E.164 without '+', e.g. 919392534625.
// Bare 10-digit Indian mobiles (6-9 prefix) get the 91 country code.

function normalizePhone(input, defaultCountry = '91') {
  if (input == null) return null;
  let d = String(input).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  d = d.replace(/\D/g, '');
  if (/^0[6-9]\d{9}$/.test(d)) d = d.slice(1);            // 09392534625
  if (/^[6-9]\d{9}$/.test(d)) d = defaultCountry + d;     // 9392534625
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

module.exports = { normalizePhone };
