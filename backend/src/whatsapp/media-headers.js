// Headers for customer-sent media served from our own domain. Customers choose what they
// send, so anything that could run script (HTML, SVG, JS, XML…) must never render inline:
// only plain photos/audio/video display in the dashboard; everything else downloads.
const INLINE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/wav', 'audio/webm',
  'video/mp4', 'video/3gpp', 'video/webm',
]);

/** RFC 6266 / 5987: ASCII fallback plus the exact UTF-8 name (Telugu, emoji…). */
function disposition(kind, filename) {
  if (!filename) return kind;
  const clean = String(filename).replace(/[\r\n"\\/]/g, '').slice(0, 200) || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/**
 * @param {string|null} mime  what Meta / the customer says the file is
 * @param {string|null} filename
 * @returns {Record<string,string>}
 */
function mediaHeaders(mime, filename) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  const inline = INLINE_TYPES.has(type);
  return {
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Disposition': disposition(inline ? 'inline' : 'attachment', filename || (inline ? null : 'file')),
    'X-Content-Type-Options': 'nosniff',
    // even if a browser renders it, nothing in it may run script or load anything
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  };
}

module.exports = { mediaHeaders, INLINE_TYPES };
