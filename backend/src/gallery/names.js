// Turns the client's Drive folder/file names into gallery data.
//
//   <design category>/<theme or style>/<design title (price)>.jpg
//   e.g. "2 frames decor/dinosour/Dinosaur Theme (10k-12k).jpeg"
//
// Pure functions only (no DB). `classify()` takes a catalogue context built
// from the database (folder -> package, theme aliases, occasion aliases).

const IMAGE_EXT = /\.(jpe?g|jfif|pjpeg|png|webp|avif|heic|heif|gif|bmp|tiff?)$/i;

// ── prices ──────────────────────────────────────────────────────
// A price needs a "k" on at least one side, so dates (2026-09-29), counters "(3)"
// and phone-like numbers are never read as prices. "(6.5k-8.5)" -> 6,500-8,500.
const NUM = '(\\d{1,3}(?:\\.\\d{1,2})?)';
const RANGE_RE = new RegExp(`(?<![\\d.])${NUM}\\s*(k)?\\s*(?:-|–|—|to)\\s*${NUM}\\s*(k)?(?![a-z\\d])`, 'i');
const SINGLE_RE = new RegExp(`(?<![\\d.])${NUM}\\s*k(?![a-z])`, 'i');
const MIN_K = 0.5;   // ₹500
const MAX_K = 200;   // ₹2,00,000

/** @returns {{min:number, max:number, match:string} | null} rupees */
function parsePrice(text) {
  if (!text) return null;
  const r = RANGE_RE.exec(text);
  if (r && (r[2] || r[4])) {
    let a = Number(r[1]); let b = Number(r[3]);
    if (a > b) [a, b] = [b, a];
    if (a >= MIN_K && b <= MAX_K) return { min: Math.round(a * 1000), max: Math.round(b * 1000), match: r[0] };
  }
  const s = SINGLE_RE.exec(text);
  if (s) {
    const v = Number(s[1]);
    if (v >= MIN_K && v <= MAX_K) return { min: Math.round(v * 1000), max: Math.round(v * 1000), match: s[0] };
  }
  return null;
}

// ── name quality ────────────────────────────────────────────────
// "generic" names say nothing about the design and are never sent to customers.
const GENERIC_PATTERNS = [
  /^[0-9a-f]{16,}$/i,                                                       // content hashes
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,        // UUIDs
  /^whats\s?app (image|video)/i,
  /^(img|vid|dsc|dscn|dcim|pxl|mvimg|fb_img|screenshot|screen shot|photo|image|images|download|unnamed|snapchat|received|pic)[\s_-]*\(?\d/i,
  /\._[a-z]{2}_/i, /_(ac|sx|sy|sl|ul|sr)\d{2,}/i,                           // marketplace downloads (Amazon)
  /^[a-z0-9]+(?:-[a-z0-9]+){4,}$/i,                                          // web slugs: saini-event-decoration-patna-...
  /\b20[0-3]\d\b/,                                                           // dated event shots ("1 11 2024 MIYAPUR")
];

// Spelling fixes for titles shown to customers (folder + file names have typos).
const WORD_FIXES = [
  [/\bbirbe\b/gi, 'Barbie'], [/\bdinoso[u]?r\b/gi, 'Dinosaur'], [/\bpegga\b/gi, 'Peppa'],
  [/\bpaw petrol\b/gi, 'Paw Patrol'], [/\btrasformers?\b/gi, 'Transformers'], [/\bvehicals?\b|\bvechicals?\b|\bvechical\b/gi, 'Vehicles'],
  [/\bsipder\b/gi, 'Spider'], [/\broblex\b/gi, 'Roblox'], [/\bcastel\b/gi, 'Castle'], [/\bpowrepuff\b/gi, 'Powerpuff'],
  [/\bmicky\b/gi, 'Mickey'], [/\bfrds\b/gi, 'Friends'], [/\bprinces\b/gi, 'Princess'], [/\bthee\b/gi, 'Theme'],
  [/\bthem\b/gi, 'Theme'], [/\bjumboo\b/gi, 'Jumbo'], [/\bhallowen\b/gi, 'Halloween'], [/\banniversery\b/gi, 'Anniversary'],
  [/\bcongulations\b/gi, 'Congratulations'], [/\bcardle ceremeony\b/gi, 'Cradle Ceremony'], [/\bceremeony\b/gi, 'Ceremony'],
  [/\bbaby boss\b/gi, 'Boss Baby'], [/\bfoot ?ball\b/gi, 'Football'], [/\bbabyshower\b/gi, 'Baby Shower'],
];

const SMALL_WORDS = new Set(['and', 'or', 'of', 'the', 'with', 'in', 'on']);
const KEEP_UPPER = new Set(['HBD', 'HBY', 'BTS', 'DIY']);

function stripExt(name) { return name.replace(/\.[a-z0-9]{2,5}$/i, ''); }

/** Removes copy markers: " - Copy", "(2)", "-1", " 3" (trailing counters). */
function stripCounters(s) {
  return s
    .replace(/\s*-\s*copy(\s*\(\d+\))?/gi, '')
    .replace(/\s*\(\d{1,3}\)/g, '')
    .replace(/-\d{1,3}$/g, '')
    .replace(/\s+\d{1,3}$/g, '');
}

function fixWords(s) { return WORD_FIXES.reduce((acc, [re, to]) => acc.replace(re, to), s); }

function titleCase(s) {
  return s.split(' ').filter(Boolean).map((w, i) => {
    if (KEEP_UPPER.has(w.toUpperCase()) && w === w.toUpperCase()) return w;
    const lower = w.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

/** "Mixed Theme (13k-15k))" -> "Mixed Theme"; "birbe (5.5k-6k)" -> "Barbie". */
function cleanTitle(base) {
  let s = stripCounters(stripExt(base).trim());
  const price = parsePrice(s);
  if (price) s = s.replace(price.match, ' ');
  s = s.replace(/[()[\]{}]+/g, ' ').replace(/[_]+/g, ' ').replace(/\s*-\s*$/g, '').replace(/^\s*-\s*/g, '');
  s = stripCounters(s.replace(/\s+/g, ' ').trim());
  s = s.replace(/\s+-\s+/g, ' - ').replace(/\s*&\s*/g, ' & ').replace(/\s+/g, ' ').trim();
  return titleCase(fixWords(s));
}

/** @returns {'proper'|'price_only'|'generic'} */
function nameQuality(base) {
  const raw = stripCounters(stripExt(base).trim());
  if (!raw) return 'generic';
  if (GENERIC_PATTERNS.some((re) => re.test(raw))) return 'generic';
  const title = cleanTitle(base);
  if (/[a-z]{2,}/i.test(title)) return 'proper';
  return parsePrice(raw) ? 'price_only' : 'generic';
}

// ── folders: style, price ───────────────────────────────────────
// Style sub-folders describe how it's built, not the character theme.
const STYLE_FOLDERS = new Map(Object.entries({
  flex: 'flex', ring: 'ring', 'simple ring': 'simple_ring', 'simple flex': 'simple_flex', 'plain flex': 'plain_flex',
  'flex ring': 'flex_ring', 'flex car theme': 'flex', 'single frame curtains': 'curtains', curtains: 'curtains',
  'normal theme': 'normal', simple: 'simple', lights: 'lights', 'wall decor': 'wall', wall: 'wall',
}));
const IGNORED_FOLDERS = new Set(['new folder']);

function folderLabel(seg) {
  const price = parsePrice(seg);
  const s = price ? seg.replace(price.match, ' ') : seg;
  return s.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Same text normalisation used for alias lookups (lower case, typos fixed, no price/counters). */
function normaliseForMatch(text) {
  let s = stripCounters(stripExt(String(text || '')));
  const price = parsePrice(s);
  if (price) s = s.replace(price.match, ' ');
  s = fixWords(s).toLowerCase().replace(/[()[\]{}_]+/g, ' ').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Everything that can be read from a path without the database.
 * @param {string} relPath path inside the gallery root, '/'-separated
 */
function analysePath(relPath) {
  const parts = String(relPath).split('/').map((p) => p.trim()).filter(Boolean);
  const file = parts.pop() || '';
  const folders = parts;
  const quality = nameQuality(file);
  const filePrice = parsePrice(stripCounters(stripExt(file)));

  let folderPrice = null;
  for (let i = folders.length - 1; i >= 0 && !folderPrice; i -= 1) folderPrice = parsePrice(folders[i]);

  let style = null;
  for (let i = folders.length - 1; i >= 1 && !style; i -= 1) {
    const label = folderLabel(folders[i]);
    if (STYLE_FOLDERS.has(label)) style = STYLE_FOLDERS.get(label);
  }

  const price = filePrice || folderPrice;
  return {
    path: parts.concat(file).join('/'),
    folders,
    file,
    isImage: IMAGE_EXT.test(file),
    quality,
    title: quality === 'generic' ? null : (quality === 'price_only' ? null : cleanTitle(file)),
    price: price ? { min: price.min, max: price.max } : null,
    priceSource: filePrice ? 'filename' : (folderPrice ? 'folder' : 'none'),
    style,
  };
}

// ── catalogue matching (needs context from the DB) ──────────────

/** Whole-word alias match, longest alias first. aliases: [{alias, id, key, name}] sorted by length desc. */
function matchAlias(text, aliases) {
  const s = ` ${normaliseForMatch(text)} `;
  if (!s.trim()) return null;
  for (const a of aliases) {
    if (s.includes(` ${a.alias} `)) return a;
  }
  return null;
}

/**
 * Builds a lookup context from catalogue rows.
 * @param {{packages: Array<{id,key,name,folder_names,default_occasion_key?}>, themeAliases: Array<{alias, theme_id, key, name}>, occasions: Array<{id,key,name,aliases}>}} rows
 */
function buildContext({ packages, themeAliases, themes = [], occasions }) {
  const folderToPackage = new Map();
  for (const p of packages) {
    for (const f of p.folder_names || []) folderToPackage.set(f.trim().toLowerCase(), p);
  }
  const themeList = [];
  for (const t of themes) themeList.push({ alias: normaliseForMatch(t.name), id: t.id, key: t.key, name: t.name });
  for (const a of themeAliases) themeList.push({ alias: normaliseForMatch(a.alias), id: a.theme_id, key: a.key, name: a.name });
  const occList = [];
  for (const o of occasions) {
    occList.push({ alias: normaliseForMatch(o.name), id: o.id, key: o.key, name: o.name });
    occList.push({ alias: normaliseForMatch(o.key.replace(/_/g, ' ')), id: o.id, key: o.key, name: o.name });
    for (const al of o.aliases || []) occList.push({ alias: normaliseForMatch(al), id: o.id, key: o.key, name: o.name });
  }
  const byLen = (a, b) => b.alias.length - a.alias.length;
  return {
    folderToPackage,
    themeAliases: themeList.filter((a) => a.alias).sort(byLen),
    occasionAliases: occList.filter((a) => a.alias).sort(byLen),
    occasionsByKey: new Map(occasions.map((o) => [o.key, o])),
  };
}

// Design categories that are birthday decor unless a folder/file says otherwise.
const DEFAULT_OCCASION = {
  ring_frame: 'birthday', single_frame: 'birthday', two_frames: 'birthday', three_frames: 'birthday',
  four_plus_frames: 'birthday', big_frame: 'birthday', basic: 'birthday', twin_birthday: 'birthday',
  welcome_arch: 'birthday', moon_theme: 'birthday', cradle_ceremony: 'cradle_ceremony', congratulations: 'congratulations',
};

/**
 * Full parse of a gallery path against the catalogue.
 * @returns analysePath() + {package, theme, occasion} (rows or null)
 */
function classify(relPath, ctx) {
  const a = analysePath(relPath);
  const { folders } = a;

  // Package: "top/sub" mapping first (e.g. "baby shower/wall (4k-4.5k)"), then the top folder.
  let pkg = null;
  if (folders.length >= 2) pkg = ctx.folderToPackage.get(`${folders[0]}/${folders[1]}`.toLowerCase()) || null;
  if (!pkg && folders.length) pkg = ctx.folderToPackage.get(folders[0].toLowerCase()) || null;

  // Theme: deepest folder first (folders are the client's own curation), then the file title.
  // The top folder is the design category and is never read as a theme ("car trunk decor" is not Cars).
  let theme = null;
  for (let i = folders.length - 1; i >= 1 && !theme; i -= 1) theme = matchAlias(folders[i], ctx.themeAliases);
  if (!theme && a.quality === 'proper') theme = matchAlias(a.file, ctx.themeAliases);

  // Occasion: any folder (deepest first, including the top one), then the title, then the category default.
  let occasion = null;
  for (let i = folders.length - 1; i >= 0 && !occasion; i -= 1) occasion = matchAlias(folders[i], ctx.occasionAliases);
  if (!occasion && a.quality === 'proper') occasion = matchAlias(a.file, ctx.occasionAliases);
  if (!occasion && pkg && DEFAULT_OCCASION[pkg.key]) {
    const o = ctx.occasionsByKey.get(DEFAULT_OCCASION[pkg.key]);
    if (o) occasion = { id: o.id, key: o.key, name: o.name };
  }

  // Price-only names ("8k.jpg") take their title from the theme (or folder).
  let { title } = a;
  if (a.quality === 'price_only') {
    const sub = folders.length > 1 ? cleanTitle(folders[folders.length - 1]) : null;
    title = theme ? theme.name : (sub || (pkg ? pkg.name : null));
  }

  return { ...a, title, package: pkg, theme, occasion };
}

module.exports = {
  parsePrice, nameQuality, cleanTitle, analysePath, classify, buildContext, matchAlias, normaliseForMatch,
  IMAGE_EXT, STYLE_FOLDERS,
};
