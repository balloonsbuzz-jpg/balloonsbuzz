const express = require('express');
const { z } = require('zod');
const { ah, parse } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
const { limits } = require('../middleware/rateLimits');
const agentConfig = require('../services/agent-config.service');
const aiTools = require('../services/ai-tools.service');

const router = express.Router();
const read = requirePermission('agent:read');
const write = requirePermission('agent:write');
const versionParam = z.coerce.number().int().positive();
const toolName = z.string().regex(/^[a-z_]{2,64}$/);

router.get('/config', read, ah(async (req, res) => res.json({ config: await agentConfig.get(req.user.tenantId) })));
router.patch('/config', write, ah(async (req, res) => res.json({ config: await agentConfig.update(req, req.body) })));
router.put('/config/api-key', write, ah(async (req, res) => res.json({ config: await agentConfig.setApiKey(req, req.body) })));
router.delete('/config/api-key', write, ah(async (req, res) => res.json({ config: await agentConfig.clearApiKey(req) })));

router.get('/config/versions', read, ah(async (req, res) => res.json({ versions: await agentConfig.listVersions(req.user.tenantId) })));
router.get('/config/versions/:version', read, ah(async (req, res) => {
  res.json({ version: await agentConfig.getVersion(req.user.tenantId, parse(versionParam, req.params.version)) });
}));
router.post('/config/versions/:version/restore', write, ah(async (req, res) => {
  res.json({ config: await agentConfig.restoreVersion(req, parse(versionParam, req.params.version)) });
}));

router.get('/tools', read, ah(async (req, res) => res.json({ tools: await aiTools.list(req.user.tenantId) })));
router.patch('/tools/:name', write, ah(async (req, res) => {
  res.json({ tool: await aiTools.update(req, parse(toolName, req.params.name), req.body) });
}));
router.post('/tools/:name/reset', write, ah(async (req, res) => {
  res.json({ tool: await aiTools.resetDescription(req, parse(toolName, req.params.name)) });
}));

// The recommended BalloonsBuzz prompt (prompts/balloonsbuzz-agent.md), to load into the editor.
router.get('/recommended-prompt', read, ah(async (req, res) => {
  const fs = require('fs');
  const { PROMPT_FILE } = require('../agent/context');
  res.json({ prompt: fs.readFileSync(PROMPT_FILE, 'utf8') });
}));

// ── test console: a private sandbox chat with the real agent (never sent to WhatsApp) ──
const sandbox = require('../agent/sandbox');

router.get('/sandbox', write, ah(async (req, res) => res.json(await sandbox.state(req.user))));

const sayBody = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  location: z.object({
    lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180),
    name: z.string().trim().max(100).optional(), address: z.string().trim().max(300).optional(),
  }).strict().optional(),
}).strict().refine((b) => b.text || b.location, 'Type a message or share a location');

router.post('/sandbox/messages', write, limits.aiTestChat, ah(async (req, res) => {
  const b = parse(sayBody, req.body);
  const result = await sandbox.customerSays(req.user, b);
  res.json({ result, ...(await sandbox.state(req.user)) });
}));

router.post('/sandbox/reset', write, ah(async (req, res) => {
  await sandbox.reset(req.user);
  res.json(await sandbox.state(req.user));
}));

router.post('/sandbox/resume', write, ah(async (req, res) => {
  await sandbox.resume(req.user);
  res.json(await sandbox.state(req.user));
}));

module.exports = router;
