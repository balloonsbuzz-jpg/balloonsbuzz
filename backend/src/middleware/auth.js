const { verifyAccessToken, loadPrincipal, can } = require('../services/auth.service');
const { unauthorized, forbidden, ah } = require('../lib/errors');

const ACCESS_COOKIE = 'bb_at';
const REFRESH_COOKIE = 'bb_rt';

const requireAuth = ah(async (req, res, next) => {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) throw unauthorized();
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    throw unauthorized('Session expired');
  }
  const user = await loadPrincipal(claims);
  if (!user) throw unauthorized('Session ended, please sign in again');
  req.user = user;
  next();
});

const requirePermission = (permission) => (req, res, next) => {
  if (!can(req.user, permission)) return next(forbidden());
  next();
};

/**
 * CSRF defence for cookie auth: SameSite=Strict cookies plus a custom header on
 * every state-changing request. Browsers can't send custom headers cross-origin
 * without a CORS preflight, which only the dashboard's origins pass (middleware/cors.js).
 */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'bb-web') return next(forbidden('Missing request header'));
  next();
}

module.exports = { requireAuth, requirePermission, csrfGuard, ACCESS_COOKIE, REFRESH_COOKIE };
