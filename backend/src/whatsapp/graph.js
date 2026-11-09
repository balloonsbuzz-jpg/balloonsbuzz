// Minimal Meta Graph API client for the WhatsApp Cloud API.
// Classifies failures so callers know whether to retry (rate limits, 5xx, network)
// or give up (bad token, outside 24h window, invalid number...).
const { env } = require('../config/env');

// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131016, 131056, 133004]);
const PERMANENT_HINTS = {
  190: 'WhatsApp access token is invalid or expired. Update it in Settings → WhatsApp.',
  131047: 'More than 24 hours since the customer last messaged. Only an approved template can be sent.',
  131026: 'Message undeliverable (the number may not be on WhatsApp).',
  131051: 'Unsupported message type.',
  132001: 'Template does not exist or is not approved for this language.',
  100: 'Invalid parameter in the request.',
};

class GraphError extends Error {
  constructor(message, { status, code, subcode, retryable, details }) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.retryable = retryable;
    this.details = details;
  }
}

const graphUrl = (path) => `${env.META_GRAPH_BASE_URL.replace(/\/$/, '')}/${env.META_API_VERSION}/${path.replace(/^\//, '')}`;

async function request(method, path, { token, body, query, timeoutMs = env.GRAPH_TIMEOUT_MS } = {}) {
  if (!token) throw new GraphError('No WhatsApp access token configured', { status: 0, code: 190, retryable: false });
  const url = new URL(graphUrl(path));
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new GraphError(`Network error calling WhatsApp API: ${err.name === 'AbortError' ? 'timeout' : err.message}`, { status: 0, retryable: true });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }

  if (!res.ok) {
    const e = data?.error || {};
    const code = e.code;
    const retryable = res.status === 429 || res.status >= 500 || RETRYABLE_CODES.has(code);
    const hint = PERMANENT_HINTS[code];
    const msg = [e.message || `WhatsApp API HTTP ${res.status}`, e.error_data?.details, hint].filter(Boolean).join(' | ');
    const err = new GraphError(msg, { status: res.status, code, subcode: e.error_subcode, retryable, details: e.error_data });
    const retryAfter = Number(res.headers.get('retry-after'));
    if (retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  return data;
}

module.exports = {
  GraphError,
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  sendMessage: (phoneNumberId, body, token) => request('POST', `${phoneNumberId}/messages`, { token, body }),
  markRead: (phoneNumberId, waMessageId, token) =>
    request('POST', `${phoneNumberId}/messages`, { token, body: { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId } }),
  phoneNumberInfo: (phoneNumberId, token) =>
    request('GET', phoneNumberId, { token, query: { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier' } }),
  mediaInfo: (mediaId, token) => request('GET', mediaId, { token }),
  /** Downloads media bytes from the short-lived URL returned by mediaInfo (needs the token too). */
  async downloadMedia(url, token) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new GraphError(`Media download failed: HTTP ${res.status}`, { status: res.status, retryable: res.status >= 500 });
    return res;
  },
};
