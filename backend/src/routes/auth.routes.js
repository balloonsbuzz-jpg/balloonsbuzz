const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { env } = require('../config/env');
const auth = require('../services/auth.service');
const audit = require('../services/audit.service');
const users = require('../users/users.service');
const { ah, parse } = require('../lib/errors');
const { requireAuth, ACCESS_COOKIE, REFRESH_COOKIE } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: env.NODE_ENV === 'test' ? 1000 : 10,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

const baseCookie = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict' };

function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie, path: '/', maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...baseCookie, path: '/api/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
}
function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie, path: '/api/auth' });
}

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

router.post('/login', loginLimiter, ah(async (req, res) => {
  const body = parse(loginSchema, req.body);
  const s = await auth.login({ ...body, ip: req.ip, userAgent: req.get('user-agent') });
  setAuthCookies(res, s);
  await audit.record({ tenantId: s.tenantId, actorType: 'user', actorUserId: s.userId, action: 'auth.login', entityType: 'user', entityId: s.userId, req });
  res.json({ ok: true });
}));

router.post('/refresh', ah(async (req, res) => {
  try {
    setAuthCookies(res, await auth.refresh(req.cookies?.[REFRESH_COOKIE]));
    res.json({ ok: true });
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
}));

router.post('/logout', requireAuth, ah(async (req, res) => {
  await auth.logout(req.user.sessionId);
  clearAuthCookies(res);
  await audit.fromReq(req, { action: 'auth.logout', entityType: 'user', entityId: req.user.id });
  res.json({ ok: true });
}));

// One-time links (invite / reset). Public, so rate-limited like sign-in.
const linkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: env.NODE_ENV === 'test' ? 1000 : 30,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});
const tokenParam = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/, 'Invalid link');

router.get('/link/:token', linkLimiter, ah(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await users.checkLink(parse(tokenParam, req.params.token)));
}));

router.post('/link/:token', linkLimiter, ah(async (req, res) => {
  const { password } = parse(z.object({ password: z.string().max(200) }), req.body);
  res.json(await users.useLink(parse(tokenParam, req.params.token), password, req));
}));

router.post('/password', requireAuth, loginLimiter, ah(async (req, res) => {
  await users.changeOwnPassword(req, parse(z.object({ current_password: z.string().min(1).max(200), new_password: z.string().max(200) }), req.body));
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => {
  const { id, fullName, email, role, permissions } = req.user;
  res.json({ user: { id, fullName, email, role, permissions } });
});

module.exports = router;
