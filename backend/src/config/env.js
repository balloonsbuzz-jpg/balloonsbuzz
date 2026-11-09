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
  TRUST_PROXY: bool.default('false'),
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
  // worker
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
});

function load(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.COOKIE_SECURE === undefined) env.COOKIE_SECURE = env.NODE_ENV === 'production';
  if (env.NODE_ENV === 'production' && !env.ENCRYPTION_KEY) {
    throw new Error('Invalid environment configuration:\n  - ENCRYPTION_KEY is required in production');
  }
  return Object.freeze(env);
}

const env = load();
module.exports = { env, load };
