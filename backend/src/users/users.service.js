// Team members, roles and one-time password links (M2b).
// Safety rules, enforced here (not only in the UI):
//   - nobody changes their own role, deactivates or removes themselves
//   - only an owner can give the owner role or change another owner
//   - the last active owner can never be demoted, deactivated or removed
//   - deactivating/removing someone signs them out everywhere and voids their links
const { query, withTx } = require('../db/pool');
const { sha256, randomToken } = require('../lib/crypto');
const { hashPassword } = require('../services/auth.service');
const audit = require('../services/audit.service');
const { badRequest, forbidden, notFound, conflict } = require('../lib/errors');

const INVITE_TTL_HOURS = 72;
const RESET_TTL_HOURS = 24;

/** Every permission a role can hold, grouped for the Roles screen. */
const PERMISSIONS = [
  ['Overview', [['dashboard:read', 'See the dashboard'], ['analytics:read', 'See analytics and export CSV']]],
  ['Conversations', [['inbox:read', 'Read chats'], ['inbox:write', 'Reply in chats'], ['handover:write', 'Take over / pause / resume the bot'],
    ['contacts:read', 'See contacts'], ['contacts:write', 'Edit contacts and tags'], ['leads:read', 'See leads'], ['leads:write', 'Edit leads']]],
  ['Bookings', [['bookings:read', 'See bookings'], ['bookings:write', 'Create and change bookings'], ['payments:write', 'Record payments and refunds']]],
  ['Catalogue', [['gallery:read', 'See the gallery'], ['gallery:write', 'Edit photos and run Drive sync'], ['pricing:read', 'See prices and rules'], ['pricing:write', 'Change prices, discounts and distance charges']]],
  ['AI', [['agent:read', 'See the AI agent and tools'], ['agent:write', 'Change the AI agent, tools and use the test chat']]],
  ['Marketing', [['templates:read', 'See templates'], ['templates:write', 'Sync and edit templates'], ['broadcasts:read', 'See broadcasts'],
    ['broadcasts:write', 'Send broadcasts'], ['automations:read', 'See follow-ups'], ['automations:write', 'Change follow-ups']]],
  ['Admin', [['users:read', 'See team members and roles'], ['users:write', 'Add, change and remove team members'], ['audit:read', 'See the audit log'],
    ['settings:read', 'See settings'], ['settings:write', 'Change settings and the WhatsApp connection']]],
];
const PERMISSION_KEYS = new Set(PERMISSIONS.flatMap(([, list]) => list.map(([k]) => k)));

const isOwner = (user) => user.role === 'owner';

const USER_SELECT = `
  SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.last_login_at, u.created_at, u.password_changed_at,
         r.id AS role_id, r.key AS role_key, r.name AS role_name,
         (u.password_hash IS NULL) AS invite_pending,
         (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
         (SELECT max(t.expires_at) FROM password_tokens t WHERE t.user_id = u.id AND t.used_at IS NULL AND t.expires_at > now()) AS link_expires_at
    FROM users u JOIN roles r ON r.id = u.role_id`;

async function list(tenantId) {
  const { rows } = await query(`${USER_SELECT} WHERE u.tenant_id = $1 AND u.deleted_at IS NULL ORDER BY u.is_active DESC, u.full_name`, [tenantId]);
  return rows;
}

async function get(tenantId, id, db = { query }) {
  const { rows: [u] } = await db.query(`${USER_SELECT} WHERE u.id = $1 AND u.tenant_id = $2 AND u.deleted_at IS NULL`, [id, tenantId]);
  if (!u) throw notFound('Team member not found');
  return u;
}

async function roleById(db, tenantId, roleId) {
  const { rows: [r] } = await db.query(`SELECT id, key, name FROM roles WHERE id = $1 AND tenant_id = $2`, [roleId, tenantId]);
  if (!r) throw badRequest('Unknown role');
  return r;
}

async function activeOwnerCount(db, tenantId) {
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.tenant_id = $1 AND r.key = 'owner' AND u.is_active AND u.deleted_at IS NULL`, [tenantId]);
  return n;
}

/** Creates a one-time link; returns the raw token (shown once, never stored). */
async function issueToken(db, { tenantId, userId, purpose, createdBy }) {
  // only the newest link works
  await db.query(`UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  const token = randomToken();
  const hours = purpose === 'invite' ? INVITE_TTL_HOURS : RESET_TTL_HOURS;
  const { rows: [t] } = await db.query(
    `INSERT INTO password_tokens (tenant_id, user_id, purpose, token_hash, expires_at, created_by)
     VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5), $6) RETURNING expires_at`,
    [tenantId, userId, purpose, sha256(token), hours, createdBy]);
  return { token, expires_at: t.expires_at, purpose };
}

const normalisePhone = (p) => (p ? String(p).replace(/\D/g, '') || null : null);

async function create(req, { full_name, email, phone, role_id }) {
  const tenantId = req.user.tenantId;
  return withTx(async (c) => {
    const role = await roleById(c, tenantId, role_id);
    if (role.key === 'owner' && !isOwner(req.user)) throw forbidden('Only an owner can add another owner');
    let u;
    try {
      ({ rows: [u] } = await c.query(
        `INSERT INTO users (tenant_id, role_id, full_name, email, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, role.id, full_name.trim(), email.toLowerCase().trim(), normalisePhone(phone)]));
    } catch (e) {
      if (e.constraint === 'uq_users_tenant_email') throw conflict('Someone on the team already uses that email');
      if (e.constraint === 'users_phone_check') throw badRequest('Use a phone number with country code, e.g. 919392534625');
      throw e;
    }
    const link = await issueToken(c, { tenantId, userId: u.id, purpose: 'invite', createdBy: req.user.id });
    await audit.fromReq(req, { action: 'user.invite', entityType: 'user', entityId: u.id, after: { full_name, email, role: role.key } }, c);
    return { user: await get(tenantId, u.id, c), link };
  });
}

async function update(req, id, patch) {
  const tenantId = req.user.tenantId;
  return withTx(async (c) => {
    const before = await get(tenantId, id, c);
    const self = id === req.user.id;
    if (before.role_key === 'owner' && !isOwner(req.user) && !self) throw forbidden('Only an owner can change an owner');
    const sets = []; const params = [];
    const add = (sql, v) => { params.push(v); sets.push(`${sql} = $${params.length}`); };
    if (patch.full_name !== undefined) add('full_name', patch.full_name.trim());
    if (patch.phone !== undefined) add('phone', normalisePhone(patch.phone));
    if (patch.role_id !== undefined && patch.role_id !== before.role_id) {
      if (self) throw badRequest('You cannot change your own role');
      const role = await roleById(c, tenantId, patch.role_id);
      if (role.key === 'owner' && !isOwner(req.user)) throw forbidden('Only an owner can give the owner role');
      if (before.role_key === 'owner' && before.is_active && (await activeOwnerCount(c, tenantId)) <= 1) throw badRequest('This is the only owner. Make someone else an owner first');
      add('role_id', role.id);
    }
    if (patch.is_active !== undefined && patch.is_active !== before.is_active) {
      if (self) throw badRequest('You cannot deactivate yourself');
      if (!patch.is_active && before.role_key === 'owner' && (await activeOwnerCount(c, tenantId)) <= 1) throw badRequest('This is the only owner and cannot be deactivated');
      add('is_active', patch.is_active);
    }
    if (!sets.length) return before;
    params.push(id);
    try {
      await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    } catch (e) {
      if (e.constraint === 'users_phone_check') throw badRequest('Use a phone number with country code, e.g. 919392534625');
      throw e;
    }
    if (patch.is_active === false || (patch.role_id !== undefined && patch.role_id !== before.role_id)) {
      // new permissions apply at the next sign-in; a deactivated person is out immediately
      await revokeAll(c, id);
    }
    const after = await get(tenantId, id, c);
    await audit.fromReq(req, {
      action: patch.is_active === false ? 'user.deactivate' : patch.is_active === true ? 'user.reactivate' : 'user.update',
      entityType: 'user', entityId: id,
      before: pick(before, ['full_name', 'phone', 'role_key', 'is_active']), after: pick(after, ['full_name', 'phone', 'role_key', 'is_active']),
    }, c);
    return after;
  });
}

async function remove(req, id) {
  const tenantId = req.user.tenantId;
  return withTx(async (c) => {
    const before = await get(tenantId, id, c);
    if (id === req.user.id) throw badRequest('You cannot remove yourself');
    if (before.role_key === 'owner') {
      if (!isOwner(req.user)) throw forbidden('Only an owner can remove an owner');
      if (before.is_active && (await activeOwnerCount(c, tenantId)) <= 1) throw badRequest('This is the only owner and cannot be removed');
    }
    // soft delete: their name stays on past messages, bookings and the audit log
    // (the email can be reused for a new invite: uniqueness only counts people not removed)
    await c.query(`UPDATE users SET deleted_at = now(), is_active = false WHERE id = $1`, [id]);
    await revokeAll(c, id);
    await audit.fromReq(req, { action: 'user.remove', entityType: 'user', entityId: id, before: pick(before, ['full_name', 'email', 'role_key']) }, c);
  });
}

async function revokeAll(db, userId, exceptSessionId = null) {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [userId, exceptSessionId]);
  if (!exceptSessionId) await db.query(`UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
}

async function signOutEverywhere(req, id) {
  const tenantId = req.user.tenantId;
  return withTx(async (c) => {
    const u = await get(tenantId, id, c);
    if (u.role_key === 'owner' && !isOwner(req.user) && id !== req.user.id) throw forbidden('Only an owner can sign out an owner');
    const { rowCount } = await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [id]);
    await audit.fromReq(req, { action: 'user.sign_out_all', entityType: 'user', entityId: id, after: { sessions: rowCount } }, c);
    return { sessions: rowCount };
  });
}

/** A new one-time link: an invite again (never set a password) or a reset. */
async function newLink(req, id) {
  const tenantId = req.user.tenantId;
  return withTx(async (c) => {
    const u = await get(tenantId, id, c);
    if (u.role_key === 'owner' && !isOwner(req.user) && id !== req.user.id) throw forbidden('Only an owner can reset an owner’s password');
    if (!u.is_active) throw badRequest('Reactivate this person first');
    const purpose = u.invite_pending ? 'invite' : 'reset';
    const link = await issueToken(c, { tenantId, userId: id, purpose, createdBy: req.user.id });
    await audit.fromReq(req, { action: purpose === 'invite' ? 'user.invite_resend' : 'user.password_reset_link', entityType: 'user', entityId: id }, c);
    return link;
  });
}

// ── one-time links (public: the person isn't signed in) ─────
async function findToken(db, token, lock = false) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token || ''))) return null;
  const { rows: [t] } = await db.query(
    `SELECT t.id, t.user_id, t.tenant_id, t.purpose, t.expires_at, u.full_name, u.email
       FROM password_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.is_active AND u.deleted_at IS NULL
      ${lock ? 'FOR UPDATE OF t' : ''}`, [sha256(token)]);
  return t || null;
}

async function checkLink(token) {
  const t = await findToken({ query }, token);
  if (!t) throw notFound('This link has expired or was already used. Ask your admin for a new one.');
  return { purpose: t.purpose, full_name: t.full_name, email: t.email, expires_at: t.expires_at };
}

function passwordProblem(password, email) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters';
  if (password.length > 200) return 'That password is too long';
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) return 'Don’t use your email in the password';
  if (/^(.)\1+$/.test(password) || /^(0123456789|1234567890|password\d*|qwerty\w*)$/i.test(password)) return 'That password is too easy to guess';
  return null;
}

async function useLink(token, password, req) {
  return withTx(async (c) => {
    const t = await findToken(c, token, true);
    if (!t) throw notFound('This link has expired or was already used. Ask your admin for a new one.');
    const problem = passwordProblem(password, t.email);
    if (problem) throw badRequest(problem);
    await c.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [t.user_id, await hashPassword(password)]);
    await c.query(`UPDATE password_tokens SET used_at = now() WHERE id = $1`, [t.id]);
    await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id]);
    await audit.record({ tenantId: t.tenant_id, actorType: 'user', actorUserId: t.user_id, action: t.purpose === 'invite' ? 'user.invite_accept' : 'user.password_reset', entityType: 'user', entityId: t.user_id, req }, c);
    return { email: t.email };
  });
}

// ── roles ─────────────────────────────────────────────────────
async function roles(tenantId) {
  const { rows } = await query(
    `SELECT r.id, r.key, r.name, r.permissions, r.is_system,
            (SELECT count(*)::int FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS members
       FROM roles r WHERE r.tenant_id = $1
      ORDER BY r.is_system DESC, CASE r.key WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'agent' THEN 2 ELSE 3 END, r.name`, [tenantId]);
  return rows;
}

function cleanPermissions(perms) {
  const out = [...new Set(perms)];
  const unknown = out.filter((p) => !PERMISSION_KEYS.has(p));
  if (unknown.length) throw badRequest(`Unknown permission: ${unknown.join(', ')}`);
  if (!out.length) throw badRequest('Pick at least one permission');
  return out.sort();
}

const roleKey = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'role';

async function createRole(req, { name, permissions }) {
  const tenantId = req.user.tenantId;
  const perms = cleanPermissions(permissions);
  return withTx(async (c) => {
    if ((await c.query(`SELECT 1 FROM roles WHERE tenant_id = $1 AND lower(name) = lower($2)`, [tenantId, name.trim()])).rowCount) {
      throw conflict('A role with that name already exists');
    }
    const base = roleKey(name);
    const { rows: used } = await c.query(`SELECT key FROM roles WHERE tenant_id = $1`, [tenantId]);
    const keys = new Set(used.map((r) => r.key));
    let key = base;
    for (let i = 2; keys.has(key); i += 1) key = `${base}_${i}`;
    const { rows: [r] } = await c.query(
      `INSERT INTO roles (tenant_id, key, name, permissions) VALUES ($1,$2,$3,$4) RETURNING id, key, name, permissions, is_system`,
      [tenantId, key, name.trim(), JSON.stringify(perms)]);
    await audit.fromReq(req, { action: 'role.create', entityType: 'role', entityId: r.id, after: { name: r.name, permissions: perms } }, c);
    return { ...r, members: 0 };
  });
}

async function updateRole(req, id, { name, permissions }) {
  const tenantId = req.user.tenantId;
  return withTx(async (c) => {
    const { rows: [before] } = await c.query(`SELECT * FROM roles WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!before) throw notFound('Role not found');
    if (before.is_system) throw badRequest('Owner, Admin and Agent are built in and cannot be changed. Create a custom role instead');
    const perms = permissions ? cleanPermissions(permissions) : before.permissions;
    const { rows: [r] } = await c.query(`UPDATE roles SET name = $2, permissions = $3 WHERE id = $1 RETURNING id, key, name, permissions, is_system`,
      [id, (name || before.name).trim(), JSON.stringify(perms)]);
    await audit.fromReq(req, { action: 'role.update', entityType: 'role', entityId: id, before: { name: before.name, permissions: before.permissions }, after: { name: r.name, permissions: perms } }, c);
    return r;
  });
}

async function deleteRole(req, id) {
  const tenantId = req.user.tenantId;
  return withTx(async (c) => {
    const { rows: [r] } = await c.query(
      `SELECT r.*, (SELECT count(*)::int FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS members
         FROM roles r WHERE r.id = $1 AND r.tenant_id = $2`, [id, tenantId]);
    if (!r) throw notFound('Role not found');
    if (r.is_system) throw badRequest('Built-in roles cannot be deleted');
    if (r.members) throw badRequest(`${r.members} team member(s) still have this role. Move them to another role first`);
    // removed users keep their old role row (FK RESTRICT), so a role once used is kept
    const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM users WHERE role_id = $1`, [id]);
    if (n) throw badRequest('This role is kept for the history of removed team members');
    await c.query(`DELETE FROM roles WHERE id = $1`, [id]);
    await audit.fromReq(req, { action: 'role.delete', entityType: 'role', entityId: id, before: { name: r.name, permissions: r.permissions } }, c);
  });
}

// ── my own password ───────────────────────────────────────────
async function changeOwnPassword(req, { current_password, new_password }) {
  const bcrypt = require('bcryptjs');
  const { rows: [u] } = await query(`SELECT id, email, password_hash FROM users WHERE id = $1`, [req.user.id]);
  if (!u?.password_hash || !(await bcrypt.compare(current_password, u.password_hash))) throw badRequest('Your current password is not right');
  if (current_password === new_password) throw badRequest('Choose a password different from the current one');
  const problem = passwordProblem(new_password, u.email);
  if (problem) throw badRequest(problem);
  await withTx(async (c) => {
    await c.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [u.id, await hashPassword(new_password)]);
    await revokeAll(c, u.id, req.user.sessionId); // other devices are signed out; this one stays
    await audit.fromReq(req, { action: 'user.password_change', entityType: 'user', entityId: u.id }, c);
  });
}

function pick(o, keys) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }

module.exports = {
  PERMISSIONS, list, get, create, update, remove, signOutEverywhere, newLink,
  checkLink, useLink, passwordProblem, roles, createRole, updateRole, deleteRole, changeOwnPassword,
};
