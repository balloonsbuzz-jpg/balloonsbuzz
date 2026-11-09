// Google Drive folder as an import source. The folder is shared "Anyone with the
// link" and read with a plain API key (Drive API v3); no OAuth, no service account.
// Drive gives every file an md5, so unchanged photos are never downloaded again.
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const FOLDER = 'application/vnd.google-apps.folder';

class DriveError extends Error {}

function driveSource({ folderId, apiKey, base = 'https://www.googleapis.com/drive/v3', fetchImpl = fetch, timeoutMs = 30_000 }) {
  if (!apiKey) throw new DriveError('Google Drive is not connected: set GDRIVE_API_KEY.');
  if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId || '')) throw new DriveError('Invalid Drive folder id.');
  const api = base.replace(/\/$/, '');

  async function get(url, { binary = false } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      let res;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) { lastErr = err; continue; }
      if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
      const body = await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) { lastErr = new DriveError(`Drive ${res.status}`); continue; }
      if (res.status === 403 || res.status === 404) {
        throw new DriveError(`Drive refused access (${res.status}). Share the folder as "Anyone with the link" and check the API key has the Drive API enabled.`);
      }
      throw new DriveError(`Drive ${res.status}: ${body.slice(0, 200)}`);
    }
    throw lastErr || new DriveError('Drive request failed');
  }

  async function listChildren(parentId) {
    const files = [];
    let pageToken = null;
    do {
      const qs = new URLSearchParams({
        q: `'${parentId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, size)',
        pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', key: apiKey,
      });
      if (pageToken) qs.set('pageToken', pageToken);
      const page = await get(`${api}/files?${qs}`);
      files.push(...(page.files || []));
      pageToken = page.nextPageToken || null;
    } while (pageToken);
    return files;
  }

  const download = (id) => get(`${api}/files/${encodeURIComponent(id)}?${new URLSearchParams({ alt: 'media', key: apiKey, supportsAllDrives: 'true' })}`, { binary: true });

  return {
    name: 'drive',
    async list() {
      const out = [];
      const visited = new Set([folderId]);
      const walk = async (id, prefix, depth) => {
        for (const f of await listChildren(id)) {
          const p = prefix ? `${prefix}/${f.name}` : f.name;
          if (f.mimeType === FOLDER) {
            if (depth < MAX_DEPTH && !visited.has(f.id)) { visited.add(f.id); await walk(f.id, p, depth + 1); }
          } else if ((f.mimeType || '').startsWith('image/')) {
            out.push({
              path: p.normalize('NFC'),
              driveFileId: f.id,
              md5: f.md5Checksum || null,
              modifiedAt: f.modifiedTime || null,
              size: f.size ? Number(f.size) : null,
              read: async () => {
                if (f.size && Number(f.size) > MAX_FILE_BYTES) throw new DriveError('file is larger than 40 MB');
                return download(f.id);
              },
            });
          }
        }
      };
      await walk(folderId, '', 0);
      return out;
    },
  };
}

module.exports = { driveSource, DriveError };
