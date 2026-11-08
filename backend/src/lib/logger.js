const winston = require('winston');

// Exact-ish key names, so analytics fields like input_tokens are not redacted.
const SECRET_KEYS = /^(.*pass(word)?|.*_?token|.*secret|.*api_?key(_enc)?|authorization|cookie|set-cookie)$/i;

// Never let credentials reach the logs, even if someone logs a whole object.
const redact = winston.format((info) => {
  const scrub = (v, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 4) return v;
    const out = Array.isArray(v) ? [] : {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : scrub(val, depth + 1);
    return out;
  };
  return scrub(info);
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  silent: process.env.NODE_ENV === 'test',
  format: winston.format.combine(redact(), winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

logger.redactForTest = (obj) => redact().transform({ ...obj });
module.exports = logger;
