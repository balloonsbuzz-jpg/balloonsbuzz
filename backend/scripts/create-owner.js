#!/usr/bin/env node
/**
 * Creates (or resets the password of) the owner account.
 *
 *   npm run create-owner -- --email owner@example.com --name "Owner Name"
 *
 * Password: taken from the OWNER_PASSWORD env var if set (min 12 chars),
 * otherwise a strong one is generated and printed ONCE. Only the bcrypt hash is stored.
 */
const crypto = require('crypto');
const { env } = require('../src/config/env');
const { pool, withTx } = require('../src/db/pool');
const { hashPassword } = require('../src/services/auth.service');
const audit = require('../src/services/audit.service');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg('email') || '').toLowerCase().trim();
  const name = (arg('name') || 'Owner').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Pass a valid --email');

  let password = process.env.OWNER_PASSWORD;
  const generated = !password;
  if (generated) password = crypto.randomBytes(12).toString('base64url');
  if (password.length < 12) throw new Error('OWNER_PASSWORD must be at least 12 characters');

  const hash = await hashPassword(password);
  const result = await withTx(async (c) => {
    const t = (await c.query(`SELECT id FROM tenants WHERE slug = $1`, [env.DEFAULT_TENANT_SLUG])).rows[0];
    if (!t) throw new Error(`Tenant "${env.DEFAULT_TENANT_SLUG}" not found. Run npm run seed first.`);
    const role = (await c.query(`SELECT id FROM roles WHERE tenant_id = $1 AND key = 'owner'`, [t.id])).rows[0];
    const existing = (await c.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL`, [t.id, email])).rows[0];
    let userId;
    if (existing) {
      await c.query(`UPDATE users SET password_hash = $2, role_id = $3, is_active = true, password_changed_at = now() WHERE id = $1`,
        [existing.id, hash, role.id]);
      await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [existing.id]);
      userId = existing.id;
    } else {
      userId = (await c.query(
        `INSERT INTO users (tenant_id, role_id, full_name, email, password_hash, password_changed_at)
         VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`, [t.id, role.id, name, email, hash])).rows[0].id;
    }
    await audit.record({ tenantId: t.id, actorType: 'system', action: existing ? 'user.reset_owner' : 'user.create_owner',
      entityType: 'user', entityId: userId, after: { email } }, c);
    return { created: !existing };
  });

  console.log(`${result.created ? 'Created' : 'Updated'} owner account: ${email}`);
  if (generated) {
    console.log(`Generated password (shown once, store it in a password manager): ${password}`);
  }
}

main()
  .catch((err) => { console.error(`create-owner failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
