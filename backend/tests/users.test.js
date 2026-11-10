// M2b: team members, one-time links, roles, safety rules, audit log.
const { pool, request, app, signedIn, PASSWORD } = require('./helpers');

const H = { 'X-Requested-With': 'bb-web' };
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
let owner; let admin; let agent; let roles; let seq = 0;
const roleId = (key) => roles.find((r) => r.key === key).id;
const email = (p) => { seq += 1; return `${p}${seq}-${Date.now()}@example.com`; };
const tokenOf = (link) => new URLSearchParams(link.path.split('?')[1]).get('token');
const anon = () => ({
  get: (u) => request(app).get(u).set(H),
  post: (u, b) => request(app).post(u).set(H).send(b),
});
async function loginAs(mail, password) {
  const a = request.agent(app);
  const r = await a.post('/api/auth/login').set(H).send({ email: mail, password });
  return { status: r.status, agent: a };
}

beforeAll(async () => {
  owner = await signedIn('owner');
  admin = await signedIn('admin');
  agent = await signedIn('agent');
  roles = (await owner.get('/api/roles')).body.roles;
});
afterAll(() => pool.end());

describe('inviting a team member', () => {
  test('invite → one-time link → they set a password → they can sign in; the link then stops working', async () => {
    const mail = email('newstaff');
    const res = await admin.post('/api/users', { full_name: 'Ravi Kumar', email: mail.toUpperCase(), phone: '+91 93925 34625', role_id: roleId('agent') });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: mail, phone: '919392534625', role_key: 'agent', invite_pending: true });
    expect(res.body.link.path).toMatch(/^\/set-password\?token=[A-Za-z0-9_-]{20,}$/);
    const token = tokenOf(res.body.link);
    // only the hash is stored
    expect((await one(`SELECT count(*)::int AS n FROM password_tokens WHERE token_hash = $1`, [token])).n).toBe(0);

    expect((await loginAs(mail, 'Balloons-2026!')).status).toBe(401); // no password yet
    const check = await anon().get(`/api/auth/link/${token}`);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ purpose: 'invite', full_name: 'Ravi Kumar', email: mail });

    expect((await anon().post(`/api/auth/link/${token}`, { password: 'short' })).body.error).toMatch(/at least 10/);
    expect((await anon().post(`/api/auth/link/${token}`, { password: 'Balloons-2026!' })).status).toBe(200);
    expect((await loginAs(mail, 'Balloons-2026!')).status).toBe(200);
    expect((await anon().get(`/api/auth/link/${token}`)).status).toBe(404);
    expect((await anon().post(`/api/auth/link/${token}`, { password: 'Another-pass-99' })).status).toBe(404);

    const a = await one(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at`, [res.body.user.id]);
    expect(a.action).toBe('user.invite');
  });

  test('same email twice is refused; a removed person’s email can be invited again', async () => {
    const mail = email('dup');
    const first = await owner.post('/api/users', { full_name: 'First One', email: mail, role_id: roleId('agent') });
    expect((await owner.post('/api/users', { full_name: 'Second', email: mail, role_id: roleId('agent') })).status).toBe(409);
    expect((await owner.del(`/api/users/${first.body.user.id}`)).status).toBe(200);
    expect((await owner.post('/api/users', { full_name: 'Second', email: mail, role_id: roleId('agent') })).status).toBe(201);
  });

  test('a new link replaces the old one; expired links do not work', async () => {
    const res = await owner.post('/api/users', { full_name: 'Link Tester', email: email('links'), role_id: roleId('agent') });
    const oldToken = tokenOf(res.body.link);
    const again = await owner.post(`/api/users/${res.body.user.id}/link`, {});
    expect(again.body.link.purpose).toBe('invite');
    expect((await anon().get(`/api/auth/link/${oldToken}`)).status).toBe(404);
    const fresh = tokenOf(again.body.link);
    await pool.query(`UPDATE password_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL`, [res.body.user.id]);
    expect((await anon().get(`/api/auth/link/${fresh}`)).status).toBe(404);
    expect((await anon().get('/api/auth/link/not-a-token')).status).toBe(400);
  });
});

describe('who may do what', () => {
  test('agents cannot see or manage the team; admins cannot create owners', async () => {
    expect((await agent.get('/api/users')).status).toBe(403);
    expect((await agent.post('/api/users', { full_name: 'X Y', email: email('x'), role_id: roleId('agent') })).status).toBe(403);
    expect((await agent.get('/api/audit')).status).toBe(403);
    const r = await admin.post('/api/users', { full_name: 'Sneaky Owner', email: email('sneak'), role_id: roleId('owner') });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Only an owner/);
  });

  test('nobody changes their own role or deactivates/removes themselves', async () => {
    const me = admin.user.id;
    expect((await admin.patch(`/api/users/${me}`, { role_id: roleId('agent') })).body.error).toMatch(/your own role/);
    expect((await admin.patch(`/api/users/${me}`, { is_active: false })).body.error).toMatch(/deactivate yourself/);
    expect((await admin.del(`/api/users/${me}`)).body.error).toMatch(/remove yourself/);
    // but name and phone are fine
    expect((await admin.patch(`/api/users/${me}`, { full_name: 'Admin Renamed' })).body.user.full_name).toBe('Admin Renamed');
  });

  test('admins cannot change or remove an owner; the last owner is protected', async () => {
    const o = owner.user.id;
    expect((await admin.patch(`/api/users/${o}`, { is_active: false })).status).toBe(403);
    expect((await admin.del(`/api/users/${o}`)).status).toBe(403);
    // with several owners, one owner may demote another (and promote them back)
    const second = await signedIn('owner');
    expect((await second.patch(`/api/users/${o}`, { role_id: roleId('admin') })).status).toBe(200);
    expect((await second.patch(`/api/users/${o}`, { role_id: roleId('owner') })).status).toBe(200);
    // a role change signs the person out (new permissions apply at next sign-in)
    expect((await owner.get('/api/auth/me')).status).toBe(401);
    owner = await signedIn('owner');
  });

  test('the only active owner cannot be demoted, deactivated or removed (service-level guard)', async () => {
    const usersService = require('../src/users/users.service');
    const { rows: others } = await pool.query(
      `UPDATE users u SET is_active = false FROM roles r WHERE r.id = u.role_id AND r.key = 'owner' AND u.id <> $1 AND u.is_active RETURNING u.id`, [owner.user.id]);
    // an owner identity that is not the target (as if a second owner's session were still valid)
    const req = { user: { id: '00000000-0000-4000-8000-000000000001', tenantId: owner.user.tenant_id, role: 'owner' }, get: () => undefined };
    try {
      await expect(usersService.update(req, owner.user.id, { role_id: roleId('admin') })).rejects.toThrow(/only owner/);
      await expect(usersService.update(req, owner.user.id, { is_active: false })).rejects.toThrow(/only owner/);
      await expect(usersService.remove(req, owner.user.id)).rejects.toThrow(/only owner/);
    } finally {
      if (others.length) await pool.query(`UPDATE users SET is_active = true WHERE id = ANY($1)`, [others.map((r) => r.id)]);
    }
  });
});

describe('deactivating, signing out, resetting', () => {
  test('deactivating someone signs them out at once; reactivating lets them back in', async () => {
    const victim = await signedIn('agent');
    expect((await victim.get('/api/auth/me')).status).toBe(200);
    const r = await owner.patch(`/api/users/${victim.user.id}`, { is_active: false });
    expect(r.body.user.is_active).toBe(false);
    expect((await victim.get('/api/auth/me')).status).toBe(401);
    expect((await loginAs(victim.user.email, PASSWORD)).status).toBe(401);
    await owner.patch(`/api/users/${victim.user.id}`, { is_active: true });
    expect((await loginAs(victim.user.email, PASSWORD)).status).toBe(200);
  });

  test('changing someone’s role signs them out so the new permissions apply', async () => {
    const p = await signedIn('agent');
    await owner.patch(`/api/users/${p.user.id}`, { role_id: roleId('admin') });
    expect((await p.get('/api/auth/me')).status).toBe(401);
    const back = await loginAs(p.user.email, PASSWORD);
    const me = await back.agent.get('/api/auth/me');
    expect(me.body.user.role).toBe('admin');
  });

  test('sign out everywhere, and a reset link for someone who forgot their password', async () => {
    const p = await signedIn('agent');
    const out = await owner.post(`/api/users/${p.user.id}/sign-out`, {});
    expect(out.body.sessions).toBe(1);
    expect((await p.get('/api/auth/me')).status).toBe(401);
    const link = (await owner.post(`/api/users/${p.user.id}/link`, {})).body.link;
    expect(link.purpose).toBe('reset');
    const token = tokenOf(link);
    expect((await anon().post(`/api/auth/link/${token}`, { password: 'Fresh-Pass-2026' })).status).toBe(200);
    expect((await loginAs(p.user.email, PASSWORD)).status).toBe(401);
    expect((await loginAs(p.user.email, 'Fresh-Pass-2026')).status).toBe(200);
  });

  test('removed people disappear from the team but stay in history', async () => {
    const p = await signedIn('agent');
    expect((await owner.del(`/api/users/${p.user.id}`)).status).toBe(200);
    const list = (await owner.get('/api/users')).body.users;
    expect(list.some((u) => u.id === p.user.id)).toBe(false);
    expect((await p.get('/api/auth/me')).status).toBe(401);
    expect(await one(`SELECT deleted_at IS NOT NULL AS gone FROM users WHERE id = $1`, [p.user.id])).toEqual({ gone: true });
  });
});

describe('my own password', () => {
  test('needs the current password; other devices are signed out, this one stays', async () => {
    const me = await signedIn('agent');
    const otherDevice = await loginAs(me.user.email, PASSWORD);
    expect((await me.post('/api/auth/password', { current_password: 'wrong-one', new_password: 'Balloon-Party-77' })).body.error).toMatch(/current password/);
    expect((await me.post('/api/auth/password', { current_password: PASSWORD, new_password: '1234567890' })).body.error).toMatch(/too easy/);
    expect((await me.post('/api/auth/password', { current_password: PASSWORD, new_password: 'Balloon-Party-77' })).status).toBe(200);
    expect((await me.get('/api/auth/me')).status).toBe(200);
    expect((await otherDevice.agent.get('/api/auth/me')).status).toBe(401);
    expect((await loginAs(me.user.email, 'Balloon-Party-77')).status).toBe(200);
  });
});

describe('roles', () => {
  test('lists built-in roles with member counts and the permission catalogue', async () => {
    const r = await owner.get('/api/roles');
    expect(r.body.roles.slice(0, 3).map((x) => x.key)).toEqual(['owner', 'admin', 'agent']);
    expect(r.body.permissions.flatMap(([, l]) => l.map(([k]) => k))).toEqual(expect.arrayContaining(['inbox:read', 'users:write', 'audit:read']));
  });

  test('custom role: create, use, edit; built-in roles are locked; a role in use cannot be deleted', async () => {
    const created = await owner.post('/api/roles', { name: 'Decor crew', permissions: ['bookings:read', 'gallery:read', 'dashboard:read'] });
    expect(created.status).toBe(201);
    expect(created.body.role.key).toBe('decor_crew');
    expect((await owner.post('/api/roles', { name: 'decor CREW', permissions: ['bookings:read'] })).status).toBe(409);
    expect((await owner.post('/api/roles', { name: 'Bad', permissions: ['*'] })).body.error).toMatch(/Unknown permission/);

    const m = await owner.post('/api/users', { full_name: 'Crew Member', email: email('crew'), role_id: created.body.role.id });
    const token = tokenOf(m.body.link);
    await anon().post(`/api/auth/link/${token}`, { password: 'Crew-Member-2026' });
    const crew = await loginAs(m.body.user.email, 'Crew-Member-2026');
    expect((await crew.agent.get('/api/bookings/board')).status).toBe(200);
    expect((await crew.agent.get('/api/conversations')).status).toBe(403);

    const edited = await owner.patch(`/api/roles/${created.body.role.id}`, { permissions: ['bookings:read', 'inbox:read'] });
    expect(edited.body.role.permissions).toEqual(['bookings:read', 'inbox:read']);
    expect((await owner.patch(`/api/roles/${roleId('agent')}`, { permissions: ['inbox:read'] })).status).toBe(400);
    expect((await owner.del(`/api/roles/${roleId('admin')}`)).status).toBe(400);
    expect((await owner.del(`/api/roles/${created.body.role.id}`)).body.error).toMatch(/still have this role/);

    const spare = await owner.post('/api/roles', { name: 'Spare role', permissions: ['dashboard:read'] });
    expect((await owner.del(`/api/roles/${spare.body.role.id}`)).status).toBe(200);
  });
});

describe('audit log', () => {
  test('newest first, filters by action/entity/person, pages with a cursor', async () => {
    const all = await owner.get('/api/audit?limit=5');
    expect(all.status).toBe(200);
    expect(all.body.entries).toHaveLength(5);
    const times = all.body.entries.map((e) => e.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(all.body.next).toMatch(/\|/);
    const page2 = await owner.get(`/api/audit?limit=5&before=${encodeURIComponent(all.body.next)}`);
    expect(page2.body.entries[0].created_at <= times.at(-1)).toBe(true);
    expect(page2.body.entries.map((e) => e.id)).not.toContain(all.body.entries[0].id);

    const invites = await owner.get('/api/audit?action=user.invite');
    expect(invites.body.entries.length).toBeGreaterThan(0);
    expect(invites.body.entries.every((e) => e.action === 'user.invite')).toBe(true);
    const userActions = await owner.get('/api/audit?action=user&limit=100');
    expect(userActions.body.entries.every((e) => e.action.startsWith('user.'))).toBe(true);
    const mine = await owner.get(`/api/audit?actor=${admin.user.id}`);
    expect(mine.body.entries.every((e) => e.actor_user_id === admin.user.id)).toBe(true);
    expect(mine.body.entries[0].actor_name).toBeTruthy();
    const roles2 = await owner.get('/api/audit?entity_type=role');
    expect(roles2.body.entries.every((e) => e.entity_type === 'role')).toBe(true);

    const facets = await owner.get('/api/audit/facets');
    expect(facets.body.actions.map((a) => a.action)).toContain('user.invite');
    expect(facets.body.actors.map((a) => a.id)).toContain(admin.user.id);
    expect((await owner.get('/api/audit?action=DROP TABLE')).status).toBe(400);
  });

  test('nothing secret ever lands in the log', async () => {
    const { rows } = await pool.query(`SELECT before::text || coalesce(after::text, '') AS t FROM audit_log WHERE action LIKE 'user.%'`);
    for (const r of rows) expect(r.t || '').not.toMatch(/password|token_hash|Balloon/);
  });
});
