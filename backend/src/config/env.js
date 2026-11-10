// Validates environment once at startup; the app refuses to boot on bad config.
const path = require('path');
const { z } = require('zod');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes hex (openssl rand -hex 32)').optional(),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: bool.optional(),
  // How many reverse proxies sit in front of the API: false/0 = none, true/1 = nginx only,
  // 2 = a host proxy (Caddy) + nginx. A wrong value makes every visitor share one IP for rate limits.
  TRUST_PROXY: z.string().regex(/^(true|false|[0-5])$/, 'Use false, true or a hop count 0-5').default('false')
    .transform((v) => (v === 'true' ? 1 : v === 'false' ? 0 : Number(v))),
  // Per-IP request ceilings per minute. Generous: they stop floods and runaway scripts, not people.
  RATE_LIMIT_API_PER_MIN: z.coerce.number().int().min(10).default(600),
  RATE_LIMIT_WEBHOOK_PER_MIN: z.coerce.number().int().min(60).default(3000),
  // A worker that has not checked in for this long makes /api/health report 503.
  WORKER_STALE_AFTER_SEC: z.coerce.number().int().min(60).default(300),
  DEFAULT_TENANT_SLUG: z.string().default('balloonsbuzz'),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  // WhatsApp Cloud API (Meta)
  META_APP_SECRET: z.string().min(8).optional(),             // verifies X-Hub-Signature-256 on webhooks
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(8).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),              // fallback when no token saved in Settings
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v20.0'),
  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  GRAPH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PUBLIC_BASE_URL: z.string().url().optional(),               // public HTTPS origin Meta calls, e.g. https://wa.balloonsbuzz.com
  // gallery photo storage: Supabase Storage (public bucket) or the local disk (dev/tests)
  GALLERY_STORAGE: z.enum(['supabase', 'local']).optional(),   // default: supabase when its keys are set
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().regex(/^[a-z0-9-]{3,63}$/).default('gallery'),
  GALLERY_LOCAL_DIR: z.string().optional(),
  // Google Drive gallery sync (folder shared "anyone with the link" + an API key)
  GDRIVE_API_KEY: z.string().min(20).optional(),
  GDRIVE_FOLDER_ID: z.string().regex(/^[A-Za-z0-9_-]{10,}$/).default('1dWyYHT5_0aFBMXIpkCLVDv9OL6Mep-7q'),
  GDRIVE_API_BASE: z.string().url().default('https://www.googleapis.com/drive/v3'),
  GDRIVE_SYNC_INTERVAL_MIN: z.coerce.number().int().min(0).default(30),  // 0 = only the "Sync now" button
  // road distance (optional; without it: straight line × road factor)
  GOOGLE_MAPS_API_KEY: z.string().min(20).optional(),
  // AI agent: wait this long after a customer message before answering (they often send several)
  AI_DEBOUNCE_MS: z.coerce.number().int().min(0).max(60_000).default(2500),
  // worker
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
});

/** Settings that are fine on a laptop but unsafe on the internet. */
function productionProblems(env) {
  const out = [];
  if (!env.ENCRYPTION_KEY) out.push('ENCRYPTION_KEY is required in production');
  if (!env.COOKIE_SECURE) out.push('COOKIE_SECURE must be true in production (sign-in cookies only over HTTPS)');
  if (!env.FRONTEND_URL.startsWith('https://')) out.push('FRONTEND_URL must be the https:// address of the dashboard');
  if (env.PUBLIC_BASE_URL && !env.PUBLIC_BASE_URL.startsWith('https://')) out.push('PUBLIC_BASE_URL must start with https:// (Meta only calls HTTPS webhooks)');
  if (/change-?me|example|placeholder|secret123/i.test(env.JWT_SECRET)) out.push('JWT_SECRET looks like a placeholder: generate one with  openssl rand -hex 48');
  if (env.GALLERY_STORAGE === 'local') out.push('GALLERY_STORAGE=local is for development only; use Supabase Storage in production');
  return out;
}

function load(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.COOKIE_SECURE === undefined) env.COOKIE_SECURE = env.NODE_ENV === 'production';
  if (env.NODE_ENV === 'production') {
    const problems = productionProblems(env);
    if (problems.length) throw new Error(`Invalid environment configuration for production:\n${problems.map((x) => `  - ${x}`).join('\n')}`);
  }
  return Object.freeze(env);
}

const env = load();
module.exports = { env, load, productionProblems };
