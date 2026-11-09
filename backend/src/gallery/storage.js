// Where normalised gallery photos live. WhatsApp downloads images from a public
// HTTPS URL, so the files must be publicly readable (object keys are content
// hashes, so they can't be guessed or listed).
//
//   supabase: Supabase Storage, public bucket  (default when SUPABASE_URL + service key are set)
//   local:    a folder on disk, served by the API at /files/gallery/  (tests, offline dev)
const fs = require('fs/promises');
const path = require('path');
const { env } = require('../config/env');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function driverName() {
  if (env.GALLERY_STORAGE) return env.GALLERY_STORAGE;
  return env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'local';
}

function localDir() {
  return path.resolve(env.GALLERY_LOCAL_DIR || path.join(REPO_ROOT, '.data', 'gallery'));
}

function apiOrigin() {
  return (env.PUBLIC_BASE_URL || `http://localhost:${env.PORT}`).replace(/\/$/, '');
}

// ── supabase ────────────────────────────────────────────────────
function supabaseDriver() {
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const bucket = env.SUPABASE_STORAGE_BUCKET;
  const headers = { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY };
  let ensured = null;

  async function call(method, url, body, extra = {}) {
    const res = await fetch(url, { method, headers: { ...headers, ...extra }, body, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Supabase Storage ${method} ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async function ensureBucket() {
    ensured = ensured || (async () => {
      const res = await fetch(`${base}/storage/v1/bucket/${bucket}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return;
      await call('POST', `${base}/storage/v1/bucket`, JSON.stringify({
        id: bucket, name: bucket, public: true, file_size_limit: 5 * 1024 * 1024, allowed_mime_types: ['image/jpeg', 'image/png'],
      }), { 'Content-Type': 'application/json' });
    })().catch((e) => { ensured = null; throw e; });
    return ensured;
  }

  return {
    name: 'supabase',
    ensureReady: ensureBucket,
    publicUrl: (key) => `${base}/storage/v1/object/public/${bucket}/${key}`,
    async put(key, buffer, contentType) {
      await ensureBucket();
      await call('POST', `${base}/storage/v1/object/${bucket}/${key}`, buffer, {
        'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': 'max-age=31536000',
      });
      return this.publicUrl(key);
    },
    async remove(keys) {
      if (!keys.length) return;
      await call('DELETE', `${base}/storage/v1/object/${bucket}`, JSON.stringify({ prefixes: keys }), { 'Content-Type': 'application/json' });
    },
  };
}

// ── local disk ──────────────────────────────────────────────────
function localDriver() {
  const dir = localDir();
  const safe = (key) => {
    const p = path.resolve(dir, key);
    if (!p.startsWith(dir + path.sep)) throw new Error('invalid storage key');
    return p;
  };
  return {
    name: 'local',
    dir,
    ensureReady: () => fs.mkdir(dir, { recursive: true }),
    publicUrl: (key) => `${apiOrigin()}/files/gallery/${key}`,
    async put(key, buffer) {
      const p = safe(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, buffer);
      return this.publicUrl(key);
    },
    async remove(keys) {
      await Promise.all(keys.map((k) => fs.rm(safe(k), { force: true })));
    },
  };
}

let instance = null;
function storage() {
  if (!instance) instance = driverName() === 'supabase' ? supabaseDriver() : localDriver();
  return instance;
}
/** Tests only. */
function _reset() { instance = null; }

module.exports = { storage, driverName, localDir, _reset };
