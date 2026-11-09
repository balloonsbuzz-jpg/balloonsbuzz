#!/usr/bin/env node
/**
 * Imports the gallery from a Google Drive "Download folder" zip.
 *
 *   npm run gallery:import -- "D:\Downloads\DECORATION NEW PHOTOS - Copy-....zip"
 *
 * Safe to run again: unchanged photos are skipped, admin overrides are kept,
 * photos missing from the new zip are marked "removed from Drive" (not deleted).
 */
const path = require('path');
const fs = require('fs');
const { env } = require('../src/config/env');
const { pool } = require('../src/db/pool');
const { runImport } = require('../src/gallery/importer');
const { zipSource } = require('../src/gallery/sources/zip');
const { driverName } = require('../src/gallery/storage');

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error('Usage: npm run gallery:import -- <path to zip>');
  const { rows: [t] } = await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [env.DEFAULT_TENANT_SLUG]);
  if (!t) throw new Error(`tenant ${env.DEFAULT_TENANT_SLUG} not found (run npm run seed)`);

  console.log(`Importing ${path.basename(file)} -> storage: ${driverName()}`);
  const started = Date.now();
  const run = await runImport({
    tenantId: t.id,
    source: zipSource(file),
    concurrency: 4,
    onProgress: (s) => process.stdout.write(`\r  ${s.seen}/${s.total} files · ${s.assets_added} new photos uploaded · ${s.errors} errors   `),
  });
  const s = run.stats;
  console.log(`\n\nDone in ${Math.round((Date.now() - started) / 1000)} s (${run.status}).`);
  console.log(`  files in zip      ${s.total}`);
  console.log(`  unique photos     ${s.assets_added} uploaded this run`);
  console.log(`  added / updated / unchanged / removed   ${s.added} / ${s.updated} / ${s.unchanged} / ${s.removed}`);
  console.log(`  sendable          ${s.sendable}`);
  console.log(`  generic names     ${s.generic}   (never sent; rename in Drive as "Design Name (8k-10k)")`);
  console.log(`  no price          ${s.unpriced}  (add a price in the name/folder, or in Gallery)`);
  if (s.errors) {
    console.log(`  errors            ${s.errors}`);
    for (const e of run.report.errors.slice(0, 10)) console.log(`    - ${e.path}: ${e.error}`);
  }
  console.log(`Full report: Gallery → Imports in the dashboard (run ${run.id}).`);
}

main()
  .catch((err) => { console.error(`gallery-import: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
