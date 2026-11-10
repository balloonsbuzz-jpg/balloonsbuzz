// Streams inbound customer media (photos, voice notes, documents) from Meta to the
// dashboard. The WhatsApp token never reaches the browser.
const express = require('express');
const { z } = require('zod');
const { Readable } = require('stream');
const { query } = require('../db/pool');
const { ah, parse, notFound } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const { getForSending } = require('../whatsapp/account.service');
const graph = require('../whatsapp/graph');
const { mediaHeaders } = require('../whatsapp/media-headers');

const router = express.Router();

router.get('/:id', requirePermission('inbox:read'), ah(async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const { rows } = await query(
    `SELECT md.wa_media_id, md.mime_type, md.original_filename, cv.whatsapp_account_id
       FROM media md
       JOIN messages m ON m.media_id = md.id
       JOIN conversations cv ON cv.id = m.conversation_id
      WHERE md.id = $1 AND md.tenant_id = $2 LIMIT 1`, [id, req.user.tenantId]);
  const md = rows[0];
  if (!md?.wa_media_id) throw notFound('Media not found');
  const account = await getForSending(md.whatsapp_account_id);
  const info = await graph.mediaInfo(md.wa_media_id, account.token);
  const upstream = await graph.downloadMedia(info.url, account.token);
  res.set(mediaHeaders(md.mime_type || upstream.headers.get('content-type'), md.original_filename));
  Readable.fromWeb(upstream.body).pipe(res);
}));

module.exports = router;
