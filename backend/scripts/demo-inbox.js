#!/usr/bin/env node
/**
 * Demo conversations for trying the inbox before the real WhatsApp number is connected.
 *
 *   node backend/scripts/demo-inbox.js          # create demo chats (needs API + worker running)
 *   node backend/scripts/demo-inbox.js --clear  # remove them
 *
 * Safety: uses a placeholder WhatsApp account with a FAKE token (never your real one),
 * fake customer numbers +91 90000 000xx, and refuses to run if a real number is connected.
 */
const crypto = require('crypto');
const { env } = require('../src/config/env');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/lib/crypto');

const DEMO_PNID = '100000000000001';
const DEMO_PHONE_PREFIX = '9190000000';
const API = process.env.DEMO_API_URL || `http://localhost:${env.PORT}`;

async function clear() {
  // bookings protect their contact (ON DELETE RESTRICT): remove demo bookings first
  await pool.query(`DELETE FROM bookings WHERE contact_id IN (SELECT id FROM contacts WHERE phone LIKE $1)`, [`${DEMO_PHONE_PREFIX}%`]);
  const c = await pool.query(`DELETE FROM contacts WHERE phone LIKE $1 RETURNING id`, [`${DEMO_PHONE_PREFIX}%`]);
  await pool.query(`DELETE FROM webhook_events WHERE phone_number_id = $1`, [DEMO_PNID]);
  const a = await pool.query(`DELETE FROM whatsapp_accounts WHERE phone_number_id = $1 RETURNING id`, [DEMO_PNID]);
  console.log(`Removed ${c.rowCount} demo customers${a.rowCount ? ' and the demo WhatsApp account' : ''}.`);
}

async function ensureDemoAccount() {
  const { rows: [t] } = await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [env.DEFAULT_TENANT_SLUG]);
  const { rows: [acc] } = await pool.query(`SELECT phone_number_id FROM whatsapp_accounts WHERE tenant_id = $1 AND is_primary`, [t.id]);
  if (acc && acc.phone_number_id !== DEMO_PNID) {
    throw new Error('A real WhatsApp number is connected. Demo data is only for setups without one.');
  }
  if (!acc) {
    await pool.query(
      `INSERT INTO whatsapp_accounts (tenant_id, display_phone, display_name, phone_number_id, waba_id, access_token_enc, status, read_receipts_enabled)
       VALUES ($1, '919392534625', 'BalloonsBuzz (demo)', $2, '100000000000002', $3, 'pending', false)`,
      [t.id, DEMO_PNID, encrypt('DEMO-TOKEN-not-a-real-meta-token')]);
  }
}

const ts = (minAgo) => String(Math.floor(Date.now() / 1000) - minAgo * 60);
const msg = (from, id, minAgo, extra) => ({ from, id, timestamp: ts(minAgo), ...extra });
const text = (body) => ({ type: 'text', text: { body } });

const DEMO = [
  { phone: `${DEMO_PHONE_PREFIX}01`, name: 'Kavya (demo)', messages: [
    [95, text('Hi! Do you do birthday decorations? 🎈')],
    [93, text('It’s for my son’s 5th birthday, Spiderman theme')],
    [90, text('Around 8 to 10k budget, venue is in Kondapur')],
  ] },
  { phone: `${DEMO_PHONE_PREFIX}02`, name: 'Ravi (demo)', messages: [
    [40, text('Need a baby shower setup next Saturday')],
    [38, text('Can I talk to a human please?')],
  ] },
  { phone: `${DEMO_PHONE_PREFIX}03`, name: 'Anu (demo)', messages: [
    [20, text('Ring frame decor for our anniversary 💕')],
    [18, { type: 'location', location: { latitude: 17.4948, longitude: 78.3563, name: 'Our home', address: 'Kondapur, Hyderabad' } }],
    [17, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'pkg_ring', title: 'Ring frame' } } }],
  ] },
  { phone: `${DEMO_PHONE_PREFIX}04`, name: 'Meena (demo)', messages: [
    [6, text('What’s the price per person for a welcome baby decor?')],
  ] },
];

async function postSigned(body) {
  const raw = JSON.stringify(body);
  const sig = `sha256=${crypto.createHmac('sha256', env.META_APP_SECRET).update(raw).digest('hex')}`;
  const res = await fetch(`${API}/webhook/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  if (res.status !== 200) throw new Error(`webhook returned ${res.status}`);
}

async function create() {
  if (!env.META_APP_SECRET) throw new Error('META_APP_SECRET is not set; the webhook would refuse demo events.');
  await ensureDemoAccount();
  let n = 0;
  for (const c of DEMO) {
    for (const [minAgo, body] of c.messages) {
      n += 1;
      await postSigned({
        object: 'whatsapp_business_account',
        entry: [{ id: 'demo', changes: [{ field: 'messages', value: {
          messaging_product: 'whatsapp', metadata: { display_phone_number: '919392534625', phone_number_id: DEMO_PNID },
          contacts: [{ profile: { name: c.name }, wa_id: c.phone }],
          messages: [msg(c.phone, `wamid.DEMO.${c.phone}.${minAgo}`, minAgo, body)],
        } }] }],
      });
    }
  }
  console.log(`Sent ${n} demo messages from ${DEMO.length} customers. The worker turns them into inbox conversations.`);
}

(process.argv.includes('--clear') ? clear() : create())
  .catch((err) => { console.error(`demo-inbox: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
