// Connect a WhatsApp number with Meta's Embedded Signup (Facebook popup), for a new number or
// for coexistence. The Meta app is shared with Whapter, whose server is the app's default
// webhook, so this number's webhooks are pointed here with a PHONE-level override. That leaves
// every other number of the app (and of the same WhatsApp account) untouched.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override
const crypto = require('crypto');
const { z } = require('zod');
const { env } = require('../config/env');
const { query, withTx } = require('../db/pool');
const { encrypt, decrypt } = require('../lib/crypto');
const { normalizePhone } = require('../lib/phone');
const { HttpError, parse, badRequest, conflict, notFound } = require('../lib/errors');
const logger = require('../lib/logger');
const audit = require('../services/audit.service');
const accounts = require('./account.service');
const graph = require('./graph');

const SDK_VERSION = 'v25.0';   // version of Facebook's browser SDK

const webhookUrl = () => `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhook/whatsapp`;

/** Server settings that must be present before the popup is worth opening. */
function missingSettings() {
  return ['META_APP_ID', 'META_APP_SECRET', 'META_SIGNUP_CONFIG_ID', 'PUBLIC_BASE_URL', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'ENCRYPTION_KEY']
    .filter((k) => !env[k]);
}

/** What the browser needs to open the popup (both ids are public by design). */
function signupConfig() {
  const missing = missingSettings();
  return {
    enabled: missing.length === 0,
    missing,
    app_id: env.META_APP_ID || null,
    config_id: env.META_SIGNUP_CONFIG_ID || null,
    sdk_version: SDK_VERSION,
    dashboard_origin: env.ALLOWED_ORIGINS[0],
  };
}

const numericId = z.string().regex(/^\d{6,25}$/);
const connectSchema = z.object({
  code: z.string().min(10).max(2000),
  mode: z.enum(['new', 'coexistence']),
  waba_id: numericId.optional().nullable(),
  phone_number_id: numericId.optional().nullable(),
  pin: z.string().regex(/^\d{6}$/, 'The PIN is 6 digits').optional().nullable(),
}).strict();

/** Meta errors → something the person at the screen can act on. */
async function meta(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof graph.GraphError)) throw err;
    logger.warn('embedded signup call failed', { what, error: err.message, code: err.code, subcode: err.subcode });
    throw new HttpError(502, `${what}: ${err.message}`);
  }
}

/** Which WhatsApp account did the customer share? Never trust the browser's id alone. */
async function resolveWaba(token, claimed) {
  const { data: info } = await meta('Checking the Facebook permission', () => graph.debugToken(token));
  if (!info?.is_valid || String(info.app_id) !== env.META_APP_ID) throw badRequest('Facebook returned a login for a different app. Please try again.');
  const scope = (info.granular_scopes || []).find((s) => s.scope === 'whatsapp_business_management');
  if (!scope && !(info.scopes || []).includes('whatsapp_business_management')) {
    throw badRequest('WhatsApp permission was not granted. Please try again and allow every permission Facebook asks for.');
  }
  const shared = scope?.target_ids || [];
  if (claimed) {
    if (shared.length && !shared.includes(claimed)) throw badRequest('That WhatsApp account was not shared with this app. Please try again.');
    return claimed;
  }
  if (!shared.length) throw badRequest('No WhatsApp Business account was shared. Please finish all the steps in the Facebook window.');
  return shared[0];   // the most recently shared one comes first
}

async function resolveNumber(wabaId, token, claimed, mode) {
  const { data: numbers = [] } = await meta('Reading the phone numbers', () => graph.listPhoneNumbers(wabaId, token));
  if (claimed) {
    const n = numbers.find((x) => x.id === claimed);
    if (!n) throw badRequest('That phone number does not belong to the WhatsApp account you shared.');
    return n;
  }
  // Coexistence reports only the account: the number is the one living in the Business app.
  const candidates = mode === 'coexistence' && numbers.some((n) => n.is_on_biz_app) ? numbers.filter((n) => n.is_on_biz_app) : numbers;
  if (!candidates.length) throw badRequest('No phone number found in this WhatsApp account. Please finish all the steps in the Facebook window.');
  if (candidates.length > 1) throw conflict('This WhatsApp account has several numbers and Facebook did not say which one you chose. Please connect again and pick the number in the Facebook window.');
  return candidates[0];
}

/** POST /settings/whatsapp/embedded-signup */
async function connect(req, body) {
  const input = parse(connectSchema, body);
  // Checked before the code is used: Meta's code works only once.
  const missing = missingSettings();
  if (missing.length) throw new HttpError(503, `Connecting is not set up on the server yet. Missing: ${missing.join(', ')}`);

  const token = await meta('Signing in with Facebook', () => graph.exchangeCode(input.code));
  const wabaId = await resolveWaba(token, input.waba_id);
  const number = await resolveNumber(wabaId, token, input.phone_number_id, input.mode);
  const phone = normalizePhone(number.display_phone_number);
  if (!phone) throw new HttpError(502, 'Meta did not return the phone number. Please try again.');

  // What Meta says about the number beats the choice on screen: registering a number that lives
  // in the Business app would log the phone out.
  const coexistence = number.is_on_biz_app ?? input.mode === 'coexistence';
  const accountId = await save(req, { wabaId, number, phone, token, coexistence });
  await runSetup(accountId, { pin: input.pin, number });
  return accounts.getPrimary(req.user.tenantId);
}

async function save(req, { wabaId, number, phone, token, coexistence }) {
  const id = await withTx(async (c) => {
    const { rows: [before] } = await c.query(`SELECT * FROM whatsapp_accounts WHERE tenant_id = $1 AND is_primary FOR UPDATE`, [req.user.tenantId]);
    const values = [phone, number.verified_name || null, number.id, wabaId, encrypt(token), coexistence];
    // A fresh onboarding may import again, so the sync columns start over. The saved PIN belongs to one number only.
    const { rows: [saved] } = before
      ? await c.query(
        `UPDATE whatsapp_accounts SET display_phone = $2, display_name = $3, waba_id = $5, access_token_enc = $6, is_coexistence = $7,
                two_step_pin_enc = CASE WHEN phone_number_id = $4 THEN two_step_pin_enc END, phone_number_id = $4,
                connection_type = 'embedded', status = 'pending', setup_steps = '[]', connected_at = now(),
                contacts_sync_status = NULL, contacts_sync_request_id = NULL,
                history_sync_status = NULL, history_sync_request_id = NULL, history_sync_progress = NULL
          WHERE id = $1 RETURNING id`, [before.id, ...values])
      : await c.query(
        `INSERT INTO whatsapp_accounts (tenant_id, display_phone, display_name, phone_number_id, waba_id, access_token_enc, is_coexistence, connection_type, connected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'embedded',now()) RETURNING id`, [req.user.tenantId, ...values]);
    const pick = (r) => r && { display_phone: r.display_phone, phone_number_id: r.phone_number_id, waba_id: r.waba_id, is_coexistence: r.is_coexistence };
    await audit.fromReq(req, {
      action: 'whatsapp_account.connect', entityType: 'whatsapp_account', entityId: saved.id, before: pick(before),
      after: { display_phone: phone, phone_number_id: number.id, waba_id: wabaId, is_coexistence: coexistence, connection_type: 'embedded' },
    }, c);
    return saved.id;
  });
  accounts.clearRouteCache();
  return id;
}

/**
 * Everything after the number is saved. Each step is independent and safe to repeat, so a
 * failure (e.g. a wrong PIN) is shown with a "finish setup" button instead of losing the login.
 */
async function runSetup(accountId, { pin, number: known } = {}) {
  const acc = await accounts.getForSending(accountId);
  if (!acc.token) throw conflict('Connect the number with Facebook first');
  const steps = [];
  const step = async (key, fn) => {
    try {
      await fn();
      steps.push({ key, ok: true });
      return true;
    } catch (err) {
      logger.warn('whatsapp setup step failed', { key, error: err.message, code: err.code, subcode: err.subcode });
      steps.push({ key, ok: false, error: setupHint(key, err) });
      return false;
    }
  };

  await step('subscribe', () => ensureSubscribed(acc));
  // Meta calls our webhook with the verify token during this request.
  await step('webhook', () => graph.setPhoneWebhook(acc.phone_number_id, webhookUrl(), env.WHATSAPP_WEBHOOK_VERIFY_TOKEN, acc.token));

  if (acc.is_coexistence) {
    // Already registered by the Business app: calling /register would disconnect the phone.
    await requestSync(acc, 'contacts', 'smb_app_state_sync', step);
    await requestSync(acc, 'history', 'history', step);
  } else {
    await step('register', () => register(acc, pin, known));
  }

  await step('check', async () => {
    const info = await graph.phoneNumberInfo(acc.phone_number_id, acc.token);
    await query(`UPDATE whatsapp_accounts SET last_health_check_at = now(), last_health_status = $2 WHERE id = $1`,
      [acc.id, JSON.stringify({ ok: true, ...info, checked_at: new Date().toISOString() })]);
  });
  // Imports are a bonus; the number works without them.
  const essential = steps.filter((s) => !s.key.startsWith('sync_'));
  await query(`UPDATE whatsapp_accounts SET status = $2, setup_steps = $3 WHERE id = $1`,
    [acc.id, essential.every((s) => s.ok) ? 'connected' : 'error', JSON.stringify(steps)]);
  return steps;
}

async function ensureSubscribed(acc) {
  const { data = [] } = await graph.subscribedApps(acc.waba_id, acc.token);
  if (data.some((a) => a.whatsapp_business_api_data?.id === env.META_APP_ID)) return;
  await graph.subscribeApp(acc.waba_id, acc.token);
}

async function register(acc, givenPin, known) {
  const info = known || await graph.phoneNumberInfo(acc.phone_number_id, acc.token);
  if (info.platform_type === 'CLOUD_API' && info.status === 'CONNECTED') return;   // already registered
  const pin = givenPin || (acc.two_step_pin_enc ? decrypt(acc.two_step_pin_enc) : String(crypto.randomInt(100_000, 1_000_000)));
  await graph.registerNumber(acc.phone_number_id, pin, acc.token);
  // Kept (encrypted) because Meta asks for it again if the number is ever re-registered.
  await query(`UPDATE whatsapp_accounts SET two_step_pin_enc = $2 WHERE id = $1`, [acc.id, encrypt(pin)]);
}

/** Ask Meta to send the phone's contacts / last 180 days of chats. Allowed once, within 24h of connecting. */
async function requestSync(acc, name, syncType, step) {
  const status = acc[`${name}_sync_status`];
  if (status && status !== 'failed') return;
  const ok = await step(`sync_${name}`, async () => {
    const r = await graph.requestAppSync(acc.phone_number_id, syncType, acc.token);
    await query(`UPDATE whatsapp_accounts SET ${name}_sync_status = 'requested', ${name}_sync_request_id = $2 WHERE id = $1`, [acc.id, r?.request_id || null]);
  });
  if (!ok) await query(`UPDATE whatsapp_accounts SET ${name}_sync_status = 'failed' WHERE id = $1`, [acc.id]);
}

function setupHint(key, err) {
  if (key === 'register' && err.code === 133005) return 'This number already has a two-step verification PIN. Enter that PIN and press “Finish setup”.';
  if (key === 'register' && err.code === 133016) return 'Too many attempts. Meta blocks registering this number for 72 hours; try again later.';
  if (key === 'webhook') return `Meta could not set this server as the number's webhook (${err.message}). Check that ${webhookUrl()} is reachable, then press “Finish setup”.`;
  return err.message;
}

const finishSchema = z.object({ pin: z.string().regex(/^\d{6}$/, 'The PIN is 6 digits').optional().nullable() }).strict();

/** POST /settings/whatsapp/finish-setup: repeat the steps after a failure. */
async function finishSetup(req, body) {
  const { pin } = parse(finishSchema, body || {});
  const missing = missingSettings();
  if (missing.length) throw new HttpError(503, `Connecting is not set up on the server yet. Missing: ${missing.join(', ')}`);
  const acc = await accounts.getPrimary(req.user.tenantId);
  if (!acc || acc.connection_type !== 'embedded' || acc.status === 'disconnected') throw notFound('Connect the number with Facebook first');
  const steps = await runSetup(acc.id, { pin });
  await audit.fromReq(req, { action: 'whatsapp_account.finish_setup', entityType: 'whatsapp_account', entityId: acc.id, after: { ok: steps.every((s) => s.ok) } });
  return accounts.getPrimary(req.user.tenantId);
}

/**
 * Stop using the number here. Chats, bookings and contacts stay. The row is kept (conversations
 * belong to it) without its token.
 */
async function disconnect(req) {
  const pub = await accounts.getPrimary(req.user.tenantId);
  if (!pub || pub.status === 'disconnected') throw notFound('No number is connected');
  const acc = await accounts.getForSending(pub.id);
  // Best effort on Meta's side. Only unsubscribe when this is the account's only number, so that
  // other numbers (e.g. ones used in Whapter) keep working. The webhook override is left alone
  // otherwise: clearing it would send this number's customer messages to the app's default server.
  if (acc.connection_type === 'embedded' && acc.token) {
    try {
      const { data: numbers = [] } = await graph.listPhoneNumbers(acc.waba_id, acc.token);
      if (numbers.length === 1 && numbers[0].id === acc.phone_number_id) await graph.unsubscribeApp(acc.waba_id, acc.token);
    } catch (err) {
      logger.warn('unsubscribe on disconnect failed', { error: err.message });
    }
  }
  await withTx(async (c) => {
    await c.query(
      `UPDATE whatsapp_accounts SET status = 'disconnected', access_token_enc = NULL, setup_steps = '[]', last_health_status = '{}',
              contacts_sync_status = NULL, history_sync_status = NULL, history_sync_progress = NULL WHERE id = $1`, [acc.id]);
    await audit.fromReq(req, {
      action: 'whatsapp_account.disconnect', entityType: 'whatsapp_account', entityId: acc.id,
      before: { status: pub.status, display_phone: pub.display_phone }, after: { status: 'disconnected' },
    }, c);
  });
  accounts.clearRouteCache();
  return accounts.getPrimary(req.user.tenantId);
}

module.exports = { signupConfig, connect, finishSetup, disconnect };
