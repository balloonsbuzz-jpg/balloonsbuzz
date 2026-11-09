const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { env } = require('./config/env');
const logger = require('./lib/logger');
const { pool } = require('./db/pool');
const { requireAuth, csrfGuard } = require('./middleware/auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(helmet());
  // Meta webhook BEFORE the JSON parser: signature verification needs the raw bytes.
  app.use('/webhook', require('./whatsapp/webhook.routes').router);
  // The SPA is served from the same origin (nginx proxies /api), so no CORS is granted.
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  app.use('/api', csrfGuard);
  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/agent', requireAuth, require('./routes/agent.routes'));
  app.use('/api/settings', requireAuth, require('./routes/settings.routes'));
  app.use('/api/media', requireAuth, require('./routes/media.routes'));

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
