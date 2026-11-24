// Called every minute by a scheduler when there is no worker process (Vercel):
// Vercel Cron, Supabase pg_cron or any cron service that can send a header.
const crypto = require('crypto');
const express = require('express');
const { env } = require('../config/env');
const { ah } = require('../lib/errors');
const health = require('../services/health.service');

const router = express.Router();
const sha = (s) => crypto.createHash('sha256').update(s).digest();

function authorised(req) {
  if (!env.CRON_SECRET) return false;
  return crypto.timingSafeEqual(sha(req.get('authorization') || ''), sha(`Bearer ${env.CRON_SECRET}`));
}

const run = ah(async (req, res) => {
  if (!authorised(req)) return res.sendStatus(401);
  await health.beat({ mode: 'cron', node: process.version });
  await require('../queue/schedules').tickSchedules();
  // Reply at once (cron services time out quickly); the queue is worked through afterwards.
  if (env.VERCEL) {
    const { waitUntil } = require('@vercel/functions');
    waitUntil(require('../queue/inline').drain(50_000));
  }
  return res.json({ ok: true });
});
router.get('/cron', run);
router.post('/cron', run);

module.exports = router;
