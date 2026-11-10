// Users & Roles and the Audit Log (M2b).
const express = require('express');
const { z } = require('zod');
const { query } = require('../db/pool');
const { ah, parse } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const users = require('../users/users.service');

const router = express.Router();
const read = requirePermission('users:read');
const write = requirePermission('users:write');
const uuid = z.string().uuid();

const phone = z.string().trim().max(20).regex(/^\+?[\d\s-]*$/, 'Digits only, with country code').nullable().optional();
const newUser = z.object({
  full_name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  phone,
  role_id: uuid,
}).strict();
const userPatch = z.object({
  full_name: z.string().trim().min(2).max(100).optional(),
  phone,
  role_id: uuid.optional(),
  is_active: z.boolean().optional(),
}).strict();
const rolePayload = z.object({
  name: z.string().trim().min(2).max(50),
  permissions: z.array(z.string().max(40)).max(60),
}).strict();

// The link is built from the browser's own origin by the UI; the API returns only the token path.
const linkOut = (l) => ({ path: `/set-password?token=${l.token}`, purpose: l.purpose, expires_at: l.expires_at });

router.get('/users', read, ah(async (req, res) => res.json({ users: await users.list(req.user.tenantId) })));

router.post('/users', write, ah(async (req, res) => {
  const { user, link } = await users.create(req, parse(newUser, req.body));
  res.status(201).json({ user, link: linkOut(link) });
}));

router.patch('/users/:id', write, ah(async (req, res) => {
  res.json({ user: await users.update(req, parse(uuid, req.params.id), parse(userPatch, req.body)) });
}));

router.delete('/users/:id', write, ah(async (req, res) => {
  await users.remove(req, parse(uuid, req.params.id));
  res.json({ ok: true });
}));

router.post('/users/:id/link', write, ah(async (req, res) => {
  res.json({ link: linkOut(await users.newLink(req, parse(uuid, req.params.id))) });
}));

router.post('/users/:id/sign-out', write, ah(async (req, res) => {
  res.json(await users.signOutEverywhere(req, parse(uuid, req.params.id)));
}));

router.get('/roles', read, ah(async (req, res) => {
  res.json({ roles: await users.roles(req.user.tenantId), permissions: users.PERMISSIONS });
}));
router.post('/roles', write, ah(async (req, res) => res.status(201).json({ role: await users.createRole(req, parse(rolePayload, req.body)) })));
router.patch('/roles/:id', write, ah(async (req, res) => {
  res.json({ role: await users.updateRole(req, parse(uuid, req.params.id), parse(rolePayload.partial(), req.body)) });
}));
router.delete('/roles/:id', write, ah(async (req, res) => {
  await users.deleteRole(req, parse(uuid, req.params.id));
  res.json({ ok: true });
}));

// ── audit log ─────────────────────────────────────────────────
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const auditQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  actor: z.union([uuid, z.enum(['bot', 'system'])]).optional(),
  entity_type: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  action: z.string().regex(/^[a-z_]+(\.[a-z_]+)?$/).max(80).optional(),
  before: z.string().regex(/^[^|]{10,40}\|[0-9a-f-]{36}$/).optional(),   // cursor: created_at|id
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get('/audit', requirePermission('audit:read'), ah(async (req, res) => {
  const f = parse(auditQuery, req.query);
  const where = ['a.tenant_id = $1'];
  const params = [req.user.tenantId];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.from) add(`a.created_at >= (?::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`, f.from);
  if (f.to) add(`a.created_at < ((?::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`, f.to);
  if (f.actor === 'bot' || f.actor === 'system') add('a.actor_type = ?', f.actor);
  else if (f.actor) add('a.actor_user_id = ?', f.actor);
  if (f.entity_type) add('a.entity_type = ?', f.entity_type);
  if (f.action) add(f.action.includes('.') ? 'a.action = ?' : `a.action LIKE ? || '.%'`, f.action);
  if (f.before) {
    const [ts, id] = f.before.split('|');
    params.push(ts, id);
    where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  const { rows } = await query(
    `SELECT a.id, a.created_at, a.actor_type, a.actor_user_id, u.full_name AS actor_name, a.action, a.entity_type, a.entity_id,
            a.before, a.after, host(a.ip) AS ip, a.user_agent
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${f.limit + 1}`, params);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  res.json({ entries: page, next: more && last ? `${last.created_at.toISOString()}|${last.id}` : null });
}));

router.get('/audit/facets', requirePermission('audit:read'), ah(async (req, res) => {
  const t = [req.user.tenantId];
  const [actions, entities, actors] = await Promise.all([
    query(`SELECT action, count(*)::int AS n FROM audit_log WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, t),
    query(`SELECT entity_type, count(*)::int AS n FROM audit_log WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, t),
    query(`SELECT u.id, u.full_name, u.deleted_at IS NOT NULL AS removed FROM users u
            WHERE u.tenant_id = $1 AND EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_user_id = u.id) ORDER BY u.full_name`, t),
  ]);
  res.json({ actions: actions.rows, entity_types: entities.rows, actors: actors.rows });
}));

module.exports = router;
