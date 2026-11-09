// A Google Drive "Download folder" zip as an import source (no Google credentials needed).
// Entries are read lazily, so a 200+ MB zip never sits in memory.
const yauzl = require('yauzl');

const MAX_FILE_BYTES = 40 * 1024 * 1024;   // refuse zip bombs / absurd files

function open(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on('entry', (e) => {
        if (!e.fileName.endsWith('/')) entries.push(e);
        zip.readEntry();
      });
      zip.once('end', () => resolve({ zip, entries }));
      zip.once('error', reject);
      zip.readEntry();
    });
  });
}

function readEntry(zip, entry) {
  if (entry.uncompressedSize > MAX_FILE_BYTES) return Promise.reject(new Error(`file is larger than ${MAX_FILE_BYTES / 1048576} MB`));
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('error', reject);
    });
  });
}

/** Drive zips wrap everything in the folder's name ("DECORATION NEW PHOTOS - Copy/..."): drop it. */
function commonRoot(names) {
  const firsts = new Set(names.map((n) => (n.includes('/') ? n.split('/')[0] : '')));
  return firsts.size === 1 && !firsts.has('') ? `${[...firsts][0]}/` : '';
}

function zipSource(file) {
  let handle = null;
  return {
    name: 'zip',
    async list() {
      handle = await open(file);
      const root = commonRoot(handle.entries.map((e) => e.fileName));
      return handle.entries
        .filter((e) => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(e.fileName))
        .map((e) => ({
          path: e.fileName.slice(root.length).normalize('NFC'),
          size: e.uncompressedSize,
          read: () => readEntry(handle.zip, e),
        }));
    },
    async close() { if (handle) handle.zip.close(); },
  };
}

module.exports = { zipSource, commonRoot };
