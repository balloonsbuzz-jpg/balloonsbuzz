// Gallery import (zip + Drive sync), admin overrides, and the bot's photo picker.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pool, signedIn } = require('./helpers');
const { image, buildZip, startDriveMock } = require('./gallery-helpers');
const { runImport } = require('../src/gallery/importer');
const { zipSource } = require('../src/gallery/sources/zip');
const { driveSource } = require('../src/gallery/sources/drive');
const { gallerySyncJob } = require('../src/gallery/sync.job');
const { env } = require('../src/config/env');

let tenantId;
let owner;
let zipFile;
let drive;

const P = {
  dino10: '2 frames decor/dinosour/Dinosaur Theme (10k-12k).jpeg',
  dino7: '2 frames decor/dinosour/Dinosaur Theme (7k-8k).jpg',
  dino15: '2 frames decor/dinosour/Dinosaur Theme (15k-18k).jpg',
  dinoSingle: 'single frame/dinosor/Dinosaur (11k-12k).jpg',
  dinoDup: 'more then 3 frames/simple/Dinosaur copy (10k-12k).jpeg',
  spidey: '2 frames decor/spiderman/8k.jpg',
  generic: '2 frames decor/car/WhatsApp Image 2026-09-29 at 3.18.14 PM.jpeg',
  unpriced: 'sequence sheet/Happy Birthday (3).jpeg',
  basic: 'BASIC (3.5-5k)/normal theme/Happy Birthday (4).jpeg',
};

async function itemByPath(p, source = 'zip') {
  const { rows: [r] } = await pool.query(`SELECT * FROM gallery_items WHERE tenant_id = $1 AND source = $2 AND source_path = $3`, [tenantId, source, p]);
  return r;
}

beforeAll(async () => {
  ({ rows: [{ id: tenantId }] } = await pool.query(`SELECT id FROM tenants WHERE slug = 'balloonsbuzz'`));
  owner = await signedIn('owner');
  const img = {};
  for (const k of Object.keys(P)) img[k] = await image(k);
  img.dinoDup = img.dino10;                                   // same photo filed under two categories
  const files = Object.entries(P).map(([k, p]) => [p, img[k]]);
  files.push(['2 frames decor/notes.txt', Buffer.from('not an image')]);
  zipFile = path.join(os.tmpdir(), `bb-gallery-${Date.now()}.zip`);
  fs.writeFileSync(zipFile, await buildZip(files));
});

afterAll(async () => {
  fs.rmSync(zipFile, { force: true });
  if (drive) await drive.close();
});

describe('zip import', () => {
  let first;
  test('imports every photo, dedupes content, and reports what the bot will not send', async () => {
    first = await runImport({ tenantId, source: zipSource(zipFile) });
    expect(first.status).toBe('succeeded');
    expect(first.stats).toMatchObject({ total: 10, added: 9, skipped: 1, errors: 0, assets_added: 8 });
    expect(first.report.generic).toEqual([P.generic]);
    expect(first.report.unpriced).toEqual([P.unpriced]);
    expect(first.report.skipped).toEqual(['2 frames decor/notes.txt']);
    expect(first.stats.sendable).toBe(7);   // 9 items - generic - unpriced

    const dino = await itemByPath(P.dino10);
    expect(dino).toMatchObject({ title: 'Dinosaur Theme', name_quality: 'proper', parsed_price_source: 'filename', is_sendable: true });
    expect(Number(dino.price_min)).toBe(10000);
    const dup = await itemByPath(P.dinoDup);
    expect(dup.asset_id).toBe(dino.asset_id);

    const basic = await itemByPath(P.basic);
    expect(basic).toMatchObject({ parsed_price_source: 'folder', parsed_style: 'normal' });
    expect([Number(basic.price_min), Number(basic.price_max)]).toEqual([3500, 5000]);

    const { rows: [asset] } = await pool.query(`SELECT * FROM gallery_assets WHERE id = $1`, [dino.asset_id]);
    expect(asset.public_url).toMatch(/^https:\/\/wa\.example\.test\/files\/gallery\/.+\.jpg$/);
    expect(fs.existsSync(path.join(env.GALLERY_LOCAL_DIR, asset.storage_key))).toBe(true);
    expect(fs.existsSync(path.join(env.GALLERY_LOCAL_DIR, asset.thumb_storage_key))).toBe(true);
  });

  test('a second run over the same zip changes 0 rows', async () => {
    const { rows: before } = await pool.query(`SELECT id, updated_at FROM gallery_items WHERE tenant_id = $1 ORDER BY id`, [tenantId]);
    const again = await runImport({ tenantId, source: zipSource(zipFile) });
    expect(again.stats).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 9, assets_added: 0 });
    const { rows: after } = await pool.query(`SELECT id, updated_at FROM gallery_items WHERE tenant_id = $1 ORDER BY id`, [tenantId]);
    expect(after).toEqual(before);
  });

  test('the import is listed with its report', async () => {
    const runs = await owner.get('/api/gallery/runs');
    expect(runs.status).toBe(200);
    expect(runs.body.runs[0]).toMatchObject({ source: 'zip', status: 'succeeded' });
    const one = await owner.get(`/api/gallery/runs/${first.id}`);
    expect(one.body.run.report.generic).toEqual([P.generic]);
  });

  test('only one import at a time', async () => {
    await pool.query(`INSERT INTO gallery_sync_runs (tenant_id, source) VALUES ($1, 'zip')`, [tenantId]);
    await expect(runImport({ tenantId, source: zipSource(zipFile) })).rejects.toMatchObject({ status: 409 });
    await pool.query(`DELETE FROM gallery_sync_runs WHERE tenant_id = $1 AND status = 'running'`, [tenantId]);
  });
});

describe('admin overrides', () => {
  test('a price makes an unpriced photo sendable, and survives a re-import', async () => {
    const item = await itemByPath(P.unpriced);
    const res = await owner.patch(`/api/gallery/items/${item.id}`, { override_price_min: 5000, override_price_max: 6500 });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ is_sendable: true, price_min: '5000.00' });

    await runImport({ tenantId, source: zipSource(zipFile) });
    const after = await itemByPath(P.unpriced);
    expect(after).toMatchObject({ is_sendable: true, override_price_min: '5000.00', override_price_max: '6500.00' });

    const { rows: [a] } = await pool.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1`, [item.id]);
    expect(a.action).toBe('gallery_item.update');
  });

  test('price overrides must come as a valid pair', async () => {
    const item = await itemByPath(P.unpriced);
    expect((await owner.patch(`/api/gallery/items/${item.id}`, { override_price_max: null })).status).toBe(400);
    expect((await owner.patch(`/api/gallery/items/${item.id}`, { override_price_min: 9000, override_price_max: 8000 })).status).toBe(400);
  });

  test('hiding removes a photo from the bot; generic photos stay out unless vouched for', async () => {
    const generic = await itemByPath(P.generic);
    let r = await owner.patch(`/api/gallery/items/${generic.id}`, { override_price_min: 7000, override_price_max: 8000 });
    expect(r.body.item.is_sendable).toBe(false);
    r = await owner.patch(`/api/gallery/items/${generic.id}`, { override_force_sendable: true, override_title: 'Cars Theme' });
    expect(r.body.item).toMatchObject({ is_sendable: true, title: 'Cars Theme' });
    r = await owner.patch(`/api/gallery/items/${generic.id}`, { override_hidden: true });
    expect(r.body.item.is_sendable).toBe(false);
  });

  test('list filters and counts', async () => {
    const stats = await owner.get('/api/gallery/stats');
    expect(stats.body).toMatchObject({ all: 9, hidden: 1, needs_price: 0, generic: 0 });
    const list = await owner.get('/api/gallery/items?status=sendable&q=dinosaur');
    expect(list.status).toBe(200);
    expect(list.body.items.every((i) => /dinosaur/i.test(i.title + i.source_path))).toBe(true);
    expect(list.body.items[0]).toHaveProperty('thumb_url');
  });

  test('agents can look but not edit', async () => {
    const agent = await signedIn('agent');
    const item = await itemByPath(P.dino10);
    expect((await agent.get('/api/gallery/items')).status).toBe(200);
    expect((await agent.patch(`/api/gallery/items/${item.id}`, { override_hidden: true })).status).toBe(403);
  });
});

describe('photo picker (what the bot sends)', () => {
  test('"Dinosaur, 2 frames, ₹10–12k" returns dinosaur 2-frame photos within the budget', async () => {
    const r = await owner.post('/api/gallery/search', { theme: 'dino', package: 'two_frames', budget_min: 10000, budget_max: 12000 });
    expect(r.status).toBe(200);
    expect(r.body.match).toMatchObject({ theme: 'Dinosaur', package: '2 Frames Decor' });
    expect(r.body.fallback).toBeNull();
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const it of r.body.items) {
      expect(it).toMatchObject({ theme: 'Dinosaur', package: '2 Frames Decor', fit: 'in_budget' });
      expect(it.price_min).toBeLessThanOrEqual(12000);
      expect(it.price_max).toBeGreaterThanOrEqual(10000);
      expect(it.caption).toMatch(/₹10,000 – ₹12,000 \(estimate\)/);
    }
  });

  test('without a category: spreads across categories and never repeats the same photo', async () => {
    const r = await owner.post('/api/gallery/search', { theme: 'dinosaur', budget_min: 10000, budget_max: 12000, limit: 5 });
    const pkgs = r.body.items.map((i) => i.package);
    expect(new Set(pkgs).size).toBeGreaterThan(1);
    const urls = r.body.items.map((i) => i.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(r.body.items.find((i) => i.price_min >= 15000)).toBeUndefined();
  });

  test('budget too low: offers the closest cheaper designs instead of random ones', async () => {
    // ₹10k design is > 15% above ₹8.5k, so not an upsell; the ₹7–8k one is the closest cheaper
    const r = await owner.post('/api/gallery/search', { theme: 'dinosaur', package: 'two_frames', budget_min: 8200, budget_max: 8500 });
    expect(r.body.fallback).toBe('cheaper');
    expect(r.body.items[0]).toMatchObject({ price_max: 8000 });
  });

  test('budget below everything: cheapest in the theme, flagged', async () => {
    const r = await owner.post('/api/gallery/search', { theme: 'dinosaur', package: 'two_frames', budget_max: 3000 });
    expect(r.body.fallback).toBe('above_budget');
    expect(r.body.items[0].price_min).toBe(7000);
  });

  test('unknown theme: nothing sent, suggestions instead', async () => {
    const r = await owner.post('/api/gallery/search', { theme: 'zorblax', budget_max: 12000 });
    expect(r.body).toMatchObject({ items: [], fallback: 'unknown_theme' });
    expect(r.body.suggestions.length).toBeGreaterThan(0);
  });

  test('never returns unsendable photos', async () => {
    const r = await owner.post('/api/gallery/search', { package: 'two_frames', limit: 5 });
    const { rows } = await pool.query(`SELECT id FROM gallery_items WHERE NOT is_sendable`);
    const bad = new Set(rows.map((x) => x.id));
    expect(r.body.items.some((i) => bad.has(i.id))).toBe(false);
  });
});

describe('Google Drive sync', () => {
  const src = () => driveSource({ folderId: env.GDRIVE_FOLDER_ID, apiKey: env.GDRIVE_API_KEY, base: env.GDRIVE_API_BASE });

  beforeAll(async () => {
    drive = await startDriveMock(Number(process.env.DRIVE_MOCK_PORT), env.GDRIVE_API_KEY);
    const root = env.GDRIVE_FOLDER_ID;
    Object.assign(drive.state.folders, {
      F2: { name: '2 frames decor', parent: root },
      Fd: { name: 'dinosour', parent: 'F2' },
      Fs: { name: 'spiderman', parent: 'F2' },
      Fb: { name: 'BASIC (3.5-5k)', parent: root },
    });
    Object.assign(drive.state.files, {
      d1: { name: 'Dinosaur Theme (10k-12k).jpeg', parent: 'Fd', bytes: await image('drive-d1') },
      d2: { name: 'Dinosaur Theme (7k-8k).jpg', parent: 'Fd', bytes: await image('drive-d2') },
      s1: { name: '8k.jpg', parent: 'Fs', bytes: await image('drive-s1') },
      b1: { name: 'Happy Birthday (4).jpeg', parent: 'Fb', bytes: await image('drive-b1') },
      x1: { name: 'readme.pdf', parent: root, bytes: Buffer.from('%PDF'), mimeType: 'application/pdf' },
    });
  });

  test('first sync imports the folder tree', async () => {
    const run = await runImport({ tenantId, source: src() });
    expect(run.stats).toMatchObject({ total: 4, added: 4, errors: 0 });
    expect(drive.state.downloads).toBe(4);
    const d1 = await itemByPath('2 frames decor/dinosour/Dinosaur Theme (10k-12k).jpeg', 'drive');
    expect(d1).toMatchObject({ drive_file_id: 'd1', is_sendable: true });
  });

  test('second sync changes 0 rows and downloads nothing', async () => {
    drive.state.downloads = 0;
    const run = await runImport({ tenantId, source: src() });
    expect(run.stats).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 4 });
    expect(drive.state.downloads).toBe(0);
  });

  test('a renamed file gets its new price; overrides on other photos stay', async () => {
    const b1 = await itemByPath('BASIC (3.5-5k)/Happy Birthday (4).jpeg', 'drive');
    await owner.patch(`/api/gallery/items/${b1.id}`, { override_title: 'Classic Birthday' });

    drive.state.files.d2.name = 'Dinosaur Theme (11k-13k).jpg';
    drive.state.downloads = 0;
    const run = await runImport({ tenantId, source: src() });
    expect(run.stats).toMatchObject({ added: 0, updated: 1, unchanged: 3 });
    expect(drive.state.downloads).toBe(0);         // same md5: metadata-only change

    const { rows: [d2] } = await pool.query(`SELECT * FROM gallery_items WHERE drive_file_id = 'd2'`);
    expect(d2.source_path).toBe('2 frames decor/dinosour/Dinosaur Theme (11k-13k).jpg');
    expect([Number(d2.price_min), Number(d2.price_max)]).toEqual([11000, 13000]);
    expect((await itemByPath('BASIC (3.5-5k)/Happy Birthday (4).jpeg', 'drive')).title).toBe('Classic Birthday');
  });

  test('a replaced photo is re-downloaded; a deleted one is marked removed, not deleted', async () => {
    drive.state.files.s1.bytes = await image('drive-s1-v2');
    delete drive.state.files.b1;
    drive.state.downloads = 0;
    const run = await runImport({ tenantId, source: src() });
    expect(run.stats).toMatchObject({ updated: 1, removed: 1, assets_added: 1 });
    expect(drive.state.downloads).toBe(1);
    const b1 = await itemByPath('BASIC (3.5-5k)/Happy Birthday (4).jpeg', 'drive');
    expect(b1).toMatchObject({ is_present_in_source: false, is_sendable: false, override_title: 'Classic Birthday' });
  });

  test('Drive refusing access fails the run with a clear message and removes nothing', async () => {
    drive.state.rejectAll = true;
    await expect(runImport({ tenantId, source: src() })).rejects.toThrow(/Anyone with the link/);
    drive.state.rejectAll = false;
    const { rows: [run] } = await pool.query(`SELECT * FROM gallery_sync_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`, [tenantId]);
    expect(run).toMatchObject({ status: 'failed', source: 'drive' });
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM gallery_items WHERE source = 'drive' AND is_present_in_source`);
    expect(n).toBe(3);
  });

  test('"Sync now" queues one job, and the job runs the sync', async () => {
    const r = await owner.post('/api/gallery/sync', {});
    expect(r.status).toBe(202);
    expect((await owner.post('/api/gallery/sync', {})).status).toBe(409);
    const { rows: [job] } = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [r.body.job_id]);
    await gallerySyncJob(job.payload, job);
    const { rows: [run] } = await pool.query(`SELECT * FROM gallery_sync_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`, [tenantId]);
    expect(run).toMatchObject({ status: 'succeeded', triggered_by: owner.user.id });
    await pool.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [job.id]);
  });
});
