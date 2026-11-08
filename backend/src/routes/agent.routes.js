const express = require('express');
const { z } = require('zod');
const { ah, parse } = require('../lib/errors');
const { requirePermission } = require('../middleware/auth');
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

module.exports = router;
