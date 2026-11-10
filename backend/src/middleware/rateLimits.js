// Request ceilings. Per IP for the whole API and the Meta webhook (stops floods and runaway
// scripts), and per signed-in user for the few actions that cost money or hit Meta/Google
// (AI test chat, imports, template sync, test messages, CSV exports).
// In-memory counters: correct for the single API container this app runs as.
const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

const TEST = env.NODE_ENV === 'test';
const common = { standardHeaders: 'draft-7', legacyHeaders: false };
const tooMany = (what) => ({ error: `Too many ${what}. Please wait a minute and try again.` });

/** Whole API, per client IP. /api/health is exempt so uptime checks never trip it. */
function apiLimiter(perMin = TEST ? 100_000 : env.RATE_LIMIT_API_PER_MIN) {
  return rateLimit({
    ...common, windowMs: 60_000, limit: perMin,
    skip: (req) => req.path === '/health',
    message: tooMany('requests'),
  });
}

/** Meta's webhook calls, per IP (Meta sends from many addresses; this only stops floods). */
function webhookLimiter(perMin = TEST ? 100_000 : env.RATE_LIMIT_WEBHOOK_PER_MIN) {
  return rateLimit({ ...common, windowMs: 60_000, limit: perMin, message: tooMany('webhook calls') });
}

/**
 * Per signed-in user (use after requireAuth). `name` keeps each action's counter separate.
 * @param {string} name
 * @param {number} limit
 * @param {number} windowMs
 */
function perUser(name, limit, windowMs = 60_000) {
  return rateLimit({
    ...common, windowMs, limit: TEST ? Math.max(limit * 100, 1000) : limit,
    keyGenerator: (req) => `${name}:${req.user?.id || req.ip}`,
    message: tooMany('of these in a short time'),
  });
}

const limits = {
  aiTestChat: perUser('ai-test-chat', 20),                       // each one is a paid model call
  heavyJob: perUser('heavy-job', 6, 10 * 60_000),                 // gallery sync, template sync, automations run
  metaCall: perUser('meta-call', 20, 10 * 60_000),                // test messages, health checks, template submits
  export: perUser('export', 30, 10 * 60_000),
};

module.exports = { apiLimiter, webhookLimiter, perUser, limits };
