const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { query, withTx } = require('../db/pool');
const { sha256, randomToken } = require('../lib/crypto');
const { unauthorized } = require('../lib/errors');

const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);

function signAccessToken({ userId, tenantId, sessionId }) {
  return jwt.sign({ sub: userId, tid: tenantId, sid: sessionId }, env.JWT_SECRET, {
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`, issuer: 'bb-api', audience: 'bb-web',
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { issuer: 'bb-api', audience: 'bb-web' });
}

async function login({ email, password, ip, userAgent }) {
  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.password_hash, u.is_active
       FROM users u JOIN tenants t ON t.id = u.tenant_id AND t.is_active AND t.slug = $2
      WHERE u.email = $1 AND u.deleted_at IS NULL`, [email.toLowerCase().trim(), env.DEFAULT_TENANT_SLUG]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !ok || !user.is_active) throw unauthorized('Email or password is incorrect');

  const refreshToken = randomToken();
  const session = await withTx(async (c) => {
    const s = await c.query(
      `INSERT INTO sessions (tenant_id, user_id, refresh_token_hash, user_agent, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6)) RETURNING id`,
      [user.tenant_id, user.id, sha256(refreshToken), userAgent?.slice(0, 300) || null, ip || null, env.REFRESH_TOKEN_TTL_DAYS]);
    await c.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    return s.rows[0];
  });
  return {
    userId: user.id, tenantId: user.tenant_id, sessionId: session.id, refreshToken,
    accessToken: signAccessToken({ userId: user.id, tenantId: user.tenant_id, sessionId: session.id }),
  };
}

/** Rotates the refresh token: the old one stops working immediately. */
async function refresh(refreshToken) {
  if (!refreshToken) throw unauthorized();
  const next = randomToken();
  const { rows } = await query(
    `UPDATE sessions s SET refresh_token_hash = $2
       FROM users u
      WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.id = s.user_id AND u.is_active AND u.deleted_at IS NULL
      RETURNING s.id, s.user_id, s.tenant_id`, [sha256(refreshToken), sha256(next)]);
  const s = rows[0];
  if (!s) throw unauthorized('Session expired, please sign in again');
  return {
    refreshToken: next,
    accessToken: signAccessToken({ userId: s.user_id, tenantId: s.tenant_id, sessionId: s.id }),
  };
}

async function logout(sessionId) {
  if (sessionId) await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

/** Loads the signed-in user for a verified token; null if the session was revoked or user disabled. */
async function loadPrincipal(claims) {
  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.full_name, u.email, r.key AS role, r.permissions
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.is_active AND u.deleted_at IS NULL`, [claims.sid, claims.sub]);
  const u = rows[0];
  if (!u) return null;
  return {
    id: u.id, tenantId: u.tenant_id, sessionId: claims.sid, fullName: u.full_name, email: u.email,
    role: u.role, permissions: u.permissions,
  };
}

const can = (user, permission) => !!user && (user.permissions.includes('*') || user.permissions.includes(permission));

module.exports = { hashPassword, login, refresh, logout, loadPrincipal, verifyAccessToken, signAccessToken, can };
