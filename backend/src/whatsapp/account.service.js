// The WhatsApp number connection (one primary account per tenant).
const { z } = require('zod');
const { env } = require('../config/env');
const { query, withTx } = require('../db/pool');
const { encrypt, decrypt } = require('../lib/crypto');
const { normalizePhone } = require('../lib/phone');
const { parse, notFound, badRequest, conflict } = require('../lib/errors');
const audit = require('../services/audit.service');
const graph = require('./graph');

const PUBLIC_COLS = `id, display_phone, display_name, phone_number_id, waba_id, status, is_primary,
  read_receipts_enabled, last_health_check_at, last_health_status, created_at, updated_at,
  connection_type, is_coexistence, setup_steps, connected_at, contacts_sync_status, history_sync_status, history_sync_progress,
  (access_token_enc IS NOT NULL) AS has_saved_token`;

function present(row) {
  if (!row) return null;
  return { ...row, token_source: row.has_saved_token ? 'ui' : (env.WHATSAPP_ACCESS_TOKEN ? 'env' : 'none') };
}

async function getPrimary(tenantId) {
  const { rows } = await query(`SELECT ${PUBLIC_COLS} FROM whatsapp_accounts WHERE tenant_id = $1 AND is_primary`, [tenantId]);
  return present(rows[0]);
}

/** Full row incl. decrypted token, for sending. Never return this to a client. */
async function getForSending(accountId) {
  const { rows } = await query(`SELECT * FROM whatsapp_accounts WHERE id = $1`, [accountId]);
  const a = rows[0];
  if (!a) throw notFound('WhatsApp account not found');
  const token = a.status === 'disconnected' ? null : a.access_token_enc ? decrypt(a.access_token_enc) : env.WHATSAPP_ACCESS_TOKEN;
  return { ...a, token };
}

// phone_number_id -> {tenantId, accountId}; tiny cache, webhooks are hot.
const routeCache = new Map();
async function routeByPhoneNumberId(phoneNumberId) {
  const hit = routeCache.get(phoneNumberId);
  if (hit && hit.exp > Date.now()) return hit.value;
  const { rows } = await query(`SELECT id, tenant_id FROM whatsapp_accounts WHERE phone_number_id = $1 AND status <> 'disconnected'`, [phoneNumberId]);
  // Unknown numbers are not cached: this process may not hear that the number was just connected.
  if (!rows[0]) return null;
  const value = { tenantId: rows[0].tenant_id, accountId: rows[0].id };
  routeCache.set(phoneNumberId, { value, exp: Date.now() + 60_000 });
  return value;
}
const clearRouteCache = () => routeCache.clear();

const upsertSchema = z.object({
  display_phone: z.string().trim().min(8).max(20),
  display_name: z.string().trim().max(100).optional().nullable(),
  phone_number_id: z.string().trim().regex(/^\d{6,25}$/, 'Phone number ID is the numeric ID from Meta (not the phone number)'),
  waba_id: z.string().trim().regex(/^\d{6,25}$/, 'WhatsApp Business Account ID is numeric'),
  access_token: z.string().trim().min(20).max(1000).optional(),
  read_receipts_enabled: z.boolean().optional(),
}).strict();

async function upsertPrimary(req, body) {
  const input = parse(upsertSchema, body);
  const phone = normalizePhone(input.display_phone);
  if (!phone) throw badRequest('Invalid input', [{ field: 'display_phone', message: 'Enter the WhatsApp number with country code, e.g. +91 93925 34625' }]);
  const tokenEnc = input.access_token ? encrypt(input.access_token) : undefined;

  await withTx(async (c) => {
    const { rows: existing } = await c.query(`SELECT * FROM whatsapp_accounts WHERE tenant_id = $1 AND is_primary FOR UPDATE`, [req.user.tenantId]);
    const before = existing[0];
    let saved;
    if (before) {
      const { rows } = await c.query(
        `UPDATE whatsapp_accounts SET display_phone = $2, display_name = $3, phone_number_id = $4, waba_id = $5,
                access_token_enc = COALESCE($6, access_token_enc),
                read_receipts_enabled = COALESCE($7, read_receipts_enabled),
                status = CASE WHEN phone_number_id <> $4 OR $6 IS NOT NULL OR status = 'disconnected' THEN 'pending' ELSE status END,
                connection_type = CASE WHEN phone_number_id <> $4 THEN 'manual' ELSE connection_type END,
                is_coexistence = is_coexistence AND phone_number_id = $4,
                setup_steps = CASE WHEN phone_number_id <> $4 THEN '[]' ELSE setup_steps END
          WHERE id = $1 RETURNING id`,
        [before.id, phone, input.display_name ?? null, input.phone_number_id, input.waba_id, tokenEnc ?? null, input.read_receipts_enabled ?? null]);
      saved = rows[0];
    } else {
      const { rows } = await c.query(
        `INSERT INTO whatsapp_accounts (tenant_id, display_phone, display_name, phone_number_id, waba_id, access_token_enc, read_receipts_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, true)) RETURNING id`,
        [req.user.tenantId, phone, input.display_name ?? null, input.phone_number_id, input.waba_id, tokenEnc ?? null, input.read_receipts_enabled ?? null]);
      saved = rows[0];
    }
    const pick = (r) => r && { display_phone: r.display_phone, phone_number_id: r.phone_number_id, waba_id: r.waba_id, display_name: r.display_name };
    await audit.fromReq(req, {
      action: before ? 'whatsapp_account.update' : 'whatsapp_account.create', entityType: 'whatsapp_account', entityId: saved.id,
      before: pick(before), after: { ...pick({ ...input, display_phone: phone }), access_token: input.access_token ? 'updated' : undefined },
    }, c);
  });
  clearRouteCache();
  return getPrimary(req.user.tenantId);
}

/** Calls Meta to confirm the number + token work; stores the result. */
async function healthCheck(req) {
  const acc = await getPrimary(req.user.tenantId);
  if (!acc) throw notFound('Connect a WhatsApp number first');
  if (acc.status === 'disconnected') throw conflict('This number is disconnected. Connect it again first.');
  const full = await getForSending(acc.id);
  let status;
  let result;
  try {
    const info = await graph.phoneNumberInfo(full.phone_number_id, full.token);
    result = { ok: true, ...info, checked_at: new Date().toISOString() };
    status = 'connected';
  } catch (err) {
    result = { ok: false, error: err.message, code: err.code ?? null, checked_at: new Date().toISOString() };
    status = 'error';
  }
  await query(`UPDATE whatsapp_accounts SET status = $2, last_health_check_at = now(), last_health_status = $3 WHERE id = $1`,
    [acc.id, status, JSON.stringify(result)]);
  await audit.fromReq(req, { action: 'whatsapp_account.health_check', entityType: 'whatsapp_account', entityId: acc.id, after: { status } });
  return { account: await getPrimary(req.user.tenantId), result };
}

function webhookInfo() {
  return {
    callback_url: env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhook/whatsapp` : null,
    verify_token_configured: !!env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    app_secret_configured: !!env.META_APP_SECRET,
    env_token_configured: !!env.WHATSAPP_ACCESS_TOKEN,
    api_version: env.META_API_VERSION,
    fields_to_subscribe: ['messages', 'smb_message_echoes', 'smb_app_state_sync', 'history'],
  };
}

module.exports = { getPrimary, getForSending, routeByPhoneNumberId, clearRouteCache, upsertPrimary, healthCheck, webhookInfo };
