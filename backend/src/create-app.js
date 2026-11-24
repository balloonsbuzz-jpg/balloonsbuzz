const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { env } = require('./config/env');
const logger = require('./lib/logger');
const health = require('./services/health.service');
const { requireAuth, csrfGuard } = require('./middleware/auth');
const { cors } = require('./middleware/cors');
const { drainAfterResponse } = require('./queue/inline');
const { apiLimiter, webhookLimiter } = require('./middleware/rateLimits');

/** @param {{apiPerMin?: number}} [opts]  apiPerMin: override the per-IP API ceiling (tests) */
function createApp(opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY); // hop count; 0 = use the socket address

  // The dashboard (app.*) and the API (api.*) are different origins of the same site, so photos
  // and voice notes must be embeddable from a sibling subdomain, but not from other sites.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  // Meta webhook BEFORE the JSON parser: signature verification needs the raw bytes.
  app.use('/webhook', webhookLimiter(), drainAfterResponse, require('./whatsapp/webhook.routes').router);
  app.use('/internal', require('./routes/internal.routes'));
  // First on /api, so errors (401, 429, 500) stay readable by the dashboard.
  app.use('/api', cors);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Gallery photos when stored on local disk (tests / offline dev). WhatsApp fetches these
  // publicly, as it would from Supabase Storage; file names are content hashes.
  const galleryStorage = require('./gallery/storage');
  if (galleryStorage.driverName() === 'local') {
    app.use('/files/gallery', helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }),
      express.static(galleryStorage.localDir(), { immutable: true, maxAge: '365d', index: false, dotfiles: 'deny' }));
  }

  // Uptime monitors call this; 503 when the database is down or (in production) the worker stopped.
  app.get('/api/health', async (req, res) => {
    const { httpStatus, body } = await health.check();
    res.set('Cache-Control', 'no-store').status(httpStatus).json(body);
  });

  app.use('/api', apiLimiter(opts.apiPerMin), csrfGuard, drainAfterResponse);
  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/agent', requireAuth, require('./routes/agent.routes'));
  app.use('/api/settings', requireAuth, require('./routes/settings.routes'));
  app.use('/api/media', requireAuth, require('./routes/media.routes'));
  app.use('/api/conversations', requireAuth, require('./routes/conversations.routes'));
  app.use('/api/stream', requireAuth, require('./routes/stream.routes'));
  app.use('/api/gallery', requireAuth, require('./routes/gallery.routes'));
  app.use('/api/pricing', requireAuth, require('./routes/pricing.routes'));
  app.use('/api/bookings', requireAuth, require('./routes/bookings.routes'));
  app.use('/api/leads', requireAuth, require('./routes/leads.routes'));
  app.use('/api', requireAuth, require('./routes/marketing.routes'));
  app.use('/api', requireAuth, require('./routes/analytics.routes'));
  app.use('/api', requireAuth, require('./routes/admin.routes'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    if (status >= 500) logger.error('request failed', { path: req.path, method: req.method, error: err.message, stack: err.stack });
    res.status(status).json({
      error: err.expose || status < 500 ? err.message : 'Something went wrong',
      ...(err.details ? { details: err.details } : {}),
    });
  });

  return app;
}

module.exports = { createApp };
