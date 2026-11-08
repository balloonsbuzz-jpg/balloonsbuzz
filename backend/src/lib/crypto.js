// AES-256-GCM for secrets stored in the DB (API keys, WhatsApp tokens).
// Format: v1.<iv b64>.<tag b64>.<ciphertext b64>
const crypto = require('crypto');
const { env } = require('../config/env');

function key() {
  if (!env.ENCRYPTION_KEY) {
    const err = new Error('ENCRYPTION_KEY is not configured; cannot store secrets');
    err.status = 503;
    err.expose = true;
    throw err;
  }
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { encrypt, decrypt, sha256, randomToken };
