// The dashboard (https://app.balloonsbuzz.com) calls the API (https://api.balloonsbuzz.com)
// with cookies. Only FRONTEND_URL and CORS_ORIGINS are allowed, each echoed exactly (never *).
// The two hosts share a registrable domain, so SameSite=Strict cookies are still sent.
const { env } = require('../config/env');

const ALLOWED = new Set(env.ALLOWED_ORIGINS);

function cors(req, res, next) {
  res.vary('Origin');
  const origin = req.get('origin');
  const allowed = !!origin && ALLOWED.has(origin);
  if (allowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, Retry-After');
  }
  if (req.method === 'OPTIONS' && req.get('access-control-request-method')) {
    if (allowed) {
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
      res.set('Access-Control-Max-Age', '600');
    }
    return res.sendStatus(204);
  }
  return next();
}

module.exports = { cors };
