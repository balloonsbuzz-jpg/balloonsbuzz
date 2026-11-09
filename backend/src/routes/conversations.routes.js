const express = require('express');
const { z } = require('zod');
const { query } = require('../db/pool');
const { ah, parse } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const conv = require('../conversations/conversations.service');
const { switchModeTx } = require('../conversations/handover.service');

const router = express.Router();
const read = requirePermission('inbox:read');
const write = requirePermission('inbox:write');
const handover = requirePermission('handover:write');
const idParam = (req) => parse(z.string().uuid(), req.params.id);

router.get('/', read, ah(async (req, res) => {
  const q = parse(z.object({
    filter: z.enum(Object.keys(conv.FILTERS)).optional(),
    search: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(100).optional(),
  }), req.query);
  res.json(await conv.list(req.user.tenantId, req.user.id, q));
}));

router.get('/counts', read, ah(async (req, res) => res.json(await conv.counts(req.user.tenantId, req.user.id))));
router.get('/:id', read, ah(async (req, res) => res.json({ conversation: await conv.get(req.user.tenantId, idParam(req)) })));

router.get('/:id/messages', read, ah(async (req, res) => {
  const q = parse(z.object({ before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
  res.json({ messages: await conv.messages(req.user.tenantId, idParam(req), q) });
}));

const sendSchema = z.object({
  text: z.string().trim().min(1, 'Type a message').max(4096),
  reply_to_message_id: z.string().uuid().optional(),
  as_note: z.boolean().optional(),
}).strict();

router.post('/:id/messages', write, ah(async (req, res) => {
  const b = parse(sendSchema, req.body);
  const id = idParam(req);
  if (b.as_note) return res.status(201).json({ note: await conv.addNote(req, id, b.text) });
  res.status(202).json({ message: await conv.agentSend(req, id, b) });
}));

router.post('/:id/read', write, ah(async (req, res) => res.json(await conv.markRead(req, idParam(req)))));
router.post('/:id/assign', write, ah(async (req, res) => {
  const { user_id: userId } = parse(z.object({ user_id: z.string().uuid().nullable() }).strict(), req.body);
  res.json({ conversation: await conv.assign(req, idParam(req), userId) });
}));
router.post('/:id/close', write, ah(async (req, res) => res.json({ conversation: await conv.setStatus(req, idParam(req), 'closed') })));
router.post('/:id/reopen', write, ah(async (req, res) => res.json({ conversation: await conv.setStatus(req, idParam(req), 'open') })));

// ── handover controls ──
const takeoverSchema = z.object({ reason: z.string().trim().max(300).optional() }).strict();
router.post('/:id/takeover', handover, ah(async (req, res) => {
  const b = parse(takeoverSchema, req.body || {});
  const c = await switchModeTx({ tenantId: req.user.tenantId, conversationId: idParam(req), to: 'human', trigger: 'agent_takeover', actorUserId: req.user.id, reason: b.reason || 'Agent took over' });
  res.json({ conversation: { id: c.id, handling_mode: c.handling_mode } });
}));

const pauseSchema = z.object({
  resume_in_minutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
  reason: z.string().trim().max(300).optional(),
}).strict();
router.post('/:id/pause', handover, ah(async (req, res) => {
  const b = parse(pauseSchema, req.body || {});
  const resumeAt = b.resume_in_minutes ? new Date(Date.now() + b.resume_in_minutes * 60_000) : undefined;
  const c = await switchModeTx({ tenantId: req.user.tenantId, conversationId: idParam(req), to: 'paused', trigger: 'agent_pause', actorUserId: req.user.id, reason: b.reason || 'Bot paused', resumeAt });
  res.json({ conversation: { id: c.id, handling_mode: c.handling_mode, bot_resume_at: c.bot_resume_at } });
}));

router.post('/:id/resume', handover, ah(async (req, res) => {
  const c = await switchModeTx({ tenantId: req.user.tenantId, conversationId: idParam(req), to: 'bot', trigger: 'agent_resume', actorUserId: req.user.id, reason: 'Agent resumed the bot' });
  res.json({ conversation: { id: c.id, handling_mode: c.handling_mode } });
}));

// canned replies for the composer ("/" shortcuts)
router.get('/meta/canned-replies', read, ah(async (req, res) => {
  const { rows } = await query(`SELECT id, shortcut, title, body FROM canned_replies WHERE tenant_id = $1 ORDER BY use_count DESC, shortcut`, [req.user.tenantId]);
  res.json({ canned_replies: rows });
}));
router.get('/meta/users', read, ah(async (req, res) => {
  const { rows } = await query(`SELECT id, full_name FROM users WHERE tenant_id = $1 AND is_active AND deleted_at IS NULL ORDER BY full_name`, [req.user.tenantId]);
  res.json({ users: rows });
}));

module.exports = router;
