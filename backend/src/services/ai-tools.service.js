// Editable agent tools: description (what the model reads), on/off, per-tool settings.
const { z } = require('zod');
const { query, withTx } = require('../db/pool');
const { notFound, badRequest, parse } = require('../lib/errors');
const { TOOL_CONFIG_SCHEMAS } = require('../agent/tools/catalog');
const audit = require('./audit.service');

const COLUMNS = `id, name, display_name, description, default_description, parameters, config,
                 is_enabled, is_required, sort_order, updated_at`;

async function list(tenantId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM ai_tools WHERE tenant_id = $1 ORDER BY sort_order, name`, [tenantId]);
  return rows.map((r) => ({ ...r, is_customised: r.description !== r.default_description }));
}

const patchSchema = z.object({
  description: z.string().trim().min(10, 'Describe the tool in at least 10 characters').max(2000).optional(),
  is_enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
}).strict();

async function getForUpdate(c, tenantId, name) {
  const { rows } = await c.query(`SELECT * FROM ai_tools WHERE tenant_id = $1 AND name = $2 FOR UPDATE`, [tenantId, name]);
  if (!rows[0]) throw notFound('Tool not found');
  return rows[0];
}

async function update(req, name, body) {
  const patch = parse(patchSchema, body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to change');
  return withTx(async (c) => {
    const tool = await getForUpdate(c, req.user.tenantId, name);
    if (patch.is_enabled === false && tool.is_required) {
      throw badRequest(`"${tool.display_name}" is required for price safety and handover, so it can't be switched off.`);
    }
    if (patch.config) {
      const schema = TOOL_CONFIG_SCHEMAS[name];
      if (!schema) throw badRequest('This tool has no implementation in this version');
      patch.config = parse(schema, { ...tool.config, ...patch.config });
    }
    const next = { ...tool, ...patch };
    const { rows } = await c.query(
      `UPDATE ai_tools SET description = $2, is_enabled = $3, config = $4, updated_by = $5 WHERE id = $1 RETURNING ${COLUMNS}`,
      [tool.id, next.description, next.is_enabled, JSON.stringify(next.config), req.user.id]);
    const changed = Object.keys(patch);
    await audit.fromReq(req, {
      action: 'ai_tool.update', entityType: 'ai_tool', entityId: tool.id,
      before: Object.fromEntries(changed.map((k) => [k, tool[k]])),
      after: Object.fromEntries(changed.map((k) => [k, rows[0][k]])),
    }, c);
    return { ...rows[0], is_customised: rows[0].description !== rows[0].default_description };
  });
}

async function resetDescription(req, name) {
  return withTx(async (c) => {
    const tool = await getForUpdate(c, req.user.tenantId, name);
    const { rows } = await c.query(
      `UPDATE ai_tools SET description = default_description, updated_by = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
      [tool.id, req.user.id]);
    await audit.fromReq(req, { action: 'ai_tool.reset_description', entityType: 'ai_tool', entityId: tool.id,
      before: { description: tool.description }, after: { description: rows[0].description } }, c);
    return { ...rows[0], is_customised: false };
  });
}

module.exports = { list, update, resetDescription };
