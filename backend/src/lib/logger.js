const winston = require('winston');

// Exact-ish key names, so analytics fields like input_tokens are not redacted.
const SECRET_KEYS = /^(.*pass(word)?|.*_?token|.*secret|.*api_?key(_enc)?|authorization|cookie|set-cookie)$/i;

// Never let credentials reach the logs, even if someone logs a whole object.
const scrub = (v, depth = 0) => {
  if (!v || typeof v !== 'object' || depth > 4) return v;
  const out = Array.isArray(v) ? [] : {};
  for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : scrub(val, depth + 1);
  return out;
};

// Must keep winston's Symbol keys (level/message) on the top-level object, or the
// transport silently drops every line. Only string keys are scrubbed.
const redact = winston.format((info) => {
  for (const k of Object.keys(info)) {
    if (k === 'level' || k === 'message') continue;
    info[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : scrub(info[k], 1);
  }
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  silent: process.env.NODE_ENV === 'test',
  format: winston.format.combine(redact(), winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

logger.redactForTest = (obj) => redact().transform({ ...obj });
module.exports = logger;
