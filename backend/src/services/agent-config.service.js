// AI Agent settings: editable prompt + model settings with full version history.
const { z } = require('zod');
const { env } = require('../config/env');
const { query, withTx } = require('../db/pool');
const { encrypt } = require('../lib/crypto');
const { notFound, conflict, parse, badRequest } = require('../lib/errors');
const audit = require('./audit.service');

const PROVIDERS = ['deepseek', 'openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'custom'];
const ENV_KEY_BY_PROVIDER = {
  deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY',
};

// Fields an admin can edit; also exactly what each version snapshot stores.
const EDITABLE = [
  'is_enabled', 'provider', 'model', 'base_url', 'fallback_model', 'system_prompt', 'temperature',
  'max_output_tokens', 'max_tool_iterations', 'max_history_messages', 'summary_every_messages',
  'max_message_chars', 'max_messages_per_turn', 'response_delay_min_ms', 'response_delay_max_ms',
  'stuck_threshold', 'handover_keywords', 'handover_message', 'out_of_hours_message', 'pricing_per_1m', 'settings',
];
const JSON_FIELDS = new Set(['handover_keywords', 'pricing_per_1m', 'settings']);

const nullableText = (max) => z.string().trim().max(max).nullable().transform((v) => (v === '' ? null : v));

const patchSchema = z.object({
  version: z.number().int().positive(),                    // optimistic concurrency
  change_note: z.string().trim().max(300).optional(),
  is_enabled: z.boolean().optional(),
  provider: z.enum(PROVIDERS).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  base_url: z.string().trim().url().regex(/^https?:\/\//).nullable().optional(),
  fallback_model: nullableText(100).optional(),
  system_prompt: z.string().min(20, 'The prompt is too short').max(50_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().min(50).max(8000).optional(),
  max_tool_iterations: z.number().int().min(1).max(20).optional(),
  max_history_messages: z.number().int().min(1).max(200).optional(),
  summary_every_messages: z.number().int().min(1).max(500).optional(),
  max_message_chars: z.number().int().min(50).max(4096).optional(),
  max_messages_per_turn: z.number().int().min(1).max(10).optional(),
  response_delay_min_ms: z.number().int().min(0).max(30_000).optional(),
  response_delay_max_ms: z.number().int().min(0).max(60_000).optional(),
  stuck_threshold: z.number().int().min(1).max(20).optional(),
  handover_keywords: z.array(z.string().trim().toLowerCase().min(1).max(50)).max(50).optional(),
  handover_message: nullableText(1000).optional(),
  out_of_hours_message: nullableText(1000).optional(),
  pricing_per_1m: z.object({
    input: z.number().min(0), cached_input: z.number().min(0), output: z.number().min(0),
    currency: z.enum(['USD', 'INR']),
  }).strict().optional(),
  settings: z.record(z.unknown()).optional(),
}).strict();

function keySource(row) {
  if (row.api_key_enc) return 'ui';
  const envName = ENV_KEY_BY_PROVIDER[row.provider];
  return envName && env[envName] ? 'env' : 'none';
}

/** Public shape: never includes the encrypted key. */
function present(row) {
  const out = { id: row.id, version: row.version, updated_at: row.updated_at };
  for (const f of EDITABLE) out[f] = row[f];
  out.temperature = Number(row.temperature);
  out.api_key_source = keySource(row);
  out.api_key_last4 = row.api_key_enc ? row.api_key_last4 : null;
  out.env_key_name = ENV_KEY_BY_PROVIDER[row.provider] || null;
  return out;
}

const snapshot = (row) => Object.fromEntries(EDITABLE.map((f) => [f, f === 'temperature' ? Number(row[f]) : row[f]]));

async function getRow(tenantId, db = { query }, forUpdate = false) {
  const { rows } = await db.query(`SELECT * FROM ai_agent_config WHERE tenant_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [tenantId]);
  if (!rows[0]) throw notFound('AI agent is not configured');
  return rows[0];
}

async function get(tenantId) {
  return present(await getRow(tenantId));
}

async function ensureBaselineVersion(c, row, userId) {
  // The seeded row has no history yet: store it so the first edit can be rolled back.
  await c.query(
    `INSERT INTO ai_agent_config_versions (tenant_id, ai_agent_config_id, version, snapshot, change_note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ai_agent_config_id, version) DO NOTHING`,
    [row.tenant_id, row.id, row.version, JSON.stringify(snapshot(row)), 'Initial configuration', userId]);
}

async function applyChanges(c, row, changes, { userId, note, req }) {
  const fields = Object.keys(changes).filter((f) => EDITABLE.includes(f));
  if (!fields.length) throw badRequest('Nothing to change');
  const merged = { ...snapshot(row), ...changes };
  if (merged.response_delay_max_ms < merged.response_delay_min_ms) {
    throw badRequest('Invalid input', [{ field: 'response_delay_max_ms', message: 'Must be at least the minimum delay' }]);
  }
  const sets = fields.map((f, i) => `${f} = $${i + 3}`);
  const values = fields.map((f) => (JSON_FIELDS.has(f) ? JSON.stringify(changes[f]) : changes[f]));
  const { rows } = await c.query(
    `UPDATE ai_agent_config SET ${sets.join(', ')}, version = version + 1, updated_by = $2
      WHERE id = $1 RETURNING *`, [row.id, userId, ...values]);
  const next = rows[0];
  await c.query(
    `INSERT INTO ai_agent_config_versions (tenant_id, ai_agent_config_id, version, snapshot, change_note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [next.tenant_id, next.id, next.version, JSON.stringify(snapshot(next)), note || null, userId]);
  const before = Object.fromEntries(fields.map((f) => [f, row[f]]));
  const after = Object.fromEntries(fields.map((f) => [f, next[f]]));
  // Prompts are long; audit stores a marker instead of the full text (the version table has it).
  if ('system_prompt' in after) {
    before.system_prompt = `[v${row.version}, ${String(row.system_prompt).length} chars]`;
    after.system_prompt = `[v${next.version}, ${String(next.system_prompt).length} chars]`;
  }
  await audit.fromReq(req, { action: 'ai_agent_config.update', entityType: 'ai_agent_config', entityId: next.id, before, after }, c);
  return next;
}

async function update(req, body) {
  const { version, change_note: note, ...changes } = parse(patchSchema, body);
  return withTx(async (c) => {
    const row = await getRow(req.user.tenantId, c, true);
    if (row.version !== version) {
      throw conflict('Someone else saved changes since you opened this page. Reload to see them.', { current_version: row.version });
    }
    await ensureBaselineVersion(c, row, req.user.id);
    return present(await applyChanges(c, row, changes, { userId: req.user.id, note, req }));
  });
}

async function listVersions(tenantId) {
  const { rows } = await query(
    `SELECT v.version, v.change_note, v.created_at, u.full_name AS created_by_name,
            length(v.snapshot->>'system_prompt') AS prompt_chars, v.snapshot->>'model' AS model
       FROM ai_agent_config_versions v
       JOIN ai_agent_config a ON a.id = v.ai_agent_config_id AND a.tenant_id = $1
       LEFT JOIN users u ON u.id = v.created_by
      ORDER BY v.version DESC LIMIT 200`, [tenantId]);
  return rows;
}

async function getVersion(tenantId, version) {
  const { rows } = await query(
    `SELECT v.version, v.snapshot, v.change_note, v.created_at
       FROM ai_agent_config_versions v JOIN ai_agent_config a ON a.id = v.ai_agent_config_id
      WHERE a.tenant_id = $1 AND v.version = $2`, [tenantId, version]);
  if (!rows[0]) throw notFound('Version not found');
  return rows[0];
}

/** Rollback = a NEW version whose content equals the old one (history is never rewritten). */
async function restoreVersion(req, version) {
  const old = await getVersion(req.user.tenantId, version);
  return withTx(async (c) => {
    const row = await getRow(req.user.tenantId, c, true);
    await ensureBaselineVersion(c, row, req.user.id);
    const changes = Object.fromEntries(EDITABLE.filter((f) => f in old.snapshot).map((f) => [f, old.snapshot[f]]));
    return present(await applyChanges(c, row, changes, { userId: req.user.id, note: `Restored version ${version}`, req }));
  });
}

const keySchema = z.object({ api_key: z.string().trim().min(10, 'That does not look like an API key').max(500) }).strict();

async function setApiKey(req, body) {
  const { api_key: apiKey } = parse(keySchema, body);
  const enc = encrypt(apiKey);
  return withTx(async (c) => {
    const row = await getRow(req.user.tenantId, c, true);
    const { rows } = await c.query(
      `UPDATE ai_agent_config SET api_key_enc = $2, api_key_last4 = $3, updated_by = $4 WHERE id = $1 RETURNING *`,
      [row.id, enc, apiKey.slice(-4), req.user.id]);
    await audit.fromReq(req, { action: 'ai_agent_config.set_api_key', entityType: 'ai_agent_config', entityId: row.id,
      after: { api_key_last4: apiKey.slice(-4) } }, c);
    return present(rows[0]);
  });
}

async function clearApiKey(req) {
  return withTx(async (c) => {
    const row = await getRow(req.user.tenantId, c, true);
    const { rows } = await c.query(
      `UPDATE ai_agent_config SET api_key_enc = NULL, api_key_last4 = NULL, updated_by = $2 WHERE id = $1 RETURNING *`,
      [row.id, req.user.id]);
    await audit.fromReq(req, { action: 'ai_agent_config.clear_api_key', entityType: 'ai_agent_config', entityId: row.id }, c);
    return present(rows[0]);
  });
}

module.exports = { get, update, listVersions, getVersion, restoreVersion, setApiKey, clearApiKey, EDITABLE, PROVIDERS };
