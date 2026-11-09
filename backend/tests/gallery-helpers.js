// Fixtures for gallery tests: tiny distinct images, a Drive-style zip, a mock Drive API.
const http = require('http');
const crypto = require('crypto');
const sharp = require('sharp');
const yazl = require('yazl');

/** A small JPEG whose bytes are unique per `seed`. */
async function image(seed, { width = 64, height = 48 } = {}) {
  const h = crypto.createHash('md5').update(String(seed)).digest();
  return sharp({ create: { width, height, channels: 3, background: { r: h[0], g: h[1], b: h[2] } } }).jpeg().toBuffer();
}

/** Builds a zip like Drive's "Download": everything inside one root folder. */
function buildZip(files, root = 'DECORATION NEW PHOTOS - Copy') {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [p, buf] of files) zip.addBuffer(buf, `${root}/${p}`);
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}

/**
 * Minimal Drive API v3: files.list by parent, files.get?alt=media.
 * tree: { folders: {id: {name, parent}}, files: {id: {name, parent, bytes}} } (mutable between syncs)
 */
function startDriveMock(port, apiKey) {
  const state = { folders: {}, files: {}, downloads: 0, listCalls: 0, rejectAll: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    if (state.rejectAll || url.searchParams.get('key') !== apiKey) return send(403, { error: { message: 'forbidden' } });
    if (url.pathname === '/drive/v3/files') {
      state.listCalls += 1;
      const m = /^'([^']+)' in parents/.exec(url.searchParams.get('q') || '');
      const parent = m && m[1];
      const files = [
        ...Object.entries(state.folders).filter(([, f]) => f.parent === parent).map(([id, f]) => ({ id, name: f.name, mimeType: 'application/vnd.google-apps.folder' })),
        ...Object.entries(state.files).filter(([, f]) => f.parent === parent).map(([id, f]) => ({
          id, name: f.name, mimeType: f.mimeType || 'image/jpeg', md5Checksum: crypto.createHash('md5').update(f.bytes).digest('hex'),
          modifiedTime: f.modifiedTime || '2026-11-01T10:00:00.000Z', size: String(f.bytes.length),
        })),
      ];
      return send(200, { files });
    }
    const dl = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (dl && url.searchParams.get('alt') === 'media') {
      const f = state.files[decodeURIComponent(dl[1])];
      if (!f) return send(404, { error: { message: 'not found' } });
      state.downloads += 1;
      return send(200, f.bytes, 'image/jpeg');
    }
    return send(404, { error: { message: 'unknown route' } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ state, close: () => new Promise((r) => server.close(r)) })));
}

module.exports = { image, buildZip, startDriveMock };
