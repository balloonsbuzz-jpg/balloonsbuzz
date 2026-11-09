// Shared helpers for tests that simulate Meta webhooks.
const crypto = require('crypto');
const { app, request } = require('./helpers');

const PNID = '109876543210';

const sign = (raw, secret = process.env.META_APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

function postWebhook(body) {
  const raw = JSON.stringify(body);
  return request(app).post('/webhook/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw);
}

const envelope = (value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '2233445566', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919392534625', phone_number_id: PNID }, ...value } }] }],
});

const ts = (offsetSec = 0) => String(Math.floor(Date.now() / 1000) + offsetSec);

const inboundText = (id, text, from, name = 'Customer', offsetSec = 0) => envelope({
  contacts: [{ profile: { name }, wa_id: from }],
  messages: [{ from, id, timestamp: ts(offsetSec), type: 'text', text: { body: text } }],
});

async function ensureAccount(owner) {
  const res = await owner.put('/api/settings/whatsapp', {
    display_phone: '+91 93925 34625', display_name: 'BalloonsBuzz', phone_number_id: PNID, waba_id: '2233445566', access_token: 'EAAui-saved-token-0123456789',
  });
  if (res.status !== 200) throw new Error(`account setup failed: ${JSON.stringify(res.body)}`);
  require('../src/whatsapp/account.service').clearRouteCache();
}

module.exports = { PNID, sign, postWebhook, envelope, inboundText, ensureAccount, ts };
