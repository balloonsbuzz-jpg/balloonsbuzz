// Append-only audit trail (audit_log is protected by a DB trigger).
const { query } = require('../db/pool');

const REDACT = /api_key|password|token|secret/i;

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj ?? null;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, REDACT.test(k) ? (v == null ? null : '[REDACTED]') : v]));
}

/**
 * @param {object} e  { tenantId, actorType:'user'|'bot'|'system', actorUserId, action:'entity.verb',
 *                      entityType, entityId, before, after, req }
 * @param {object} [db]  pg client when inside a transaction
 */
async function record(e, db = { query }) {
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, before, after, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.tenantId, e.actorType || 'user', e.actorUserId || null, e.action, e.entityType, e.entityId || null,
      e.before ? JSON.stringify(redact(e.before)) : null, e.after ? JSON.stringify(redact(e.after)) : null,
      e.req?.ip || null, e.req?.get?.('user-agent')?.slice(0, 300) || null],
  );
}

/** Shorthand for a request made by the signed-in user. */
const fromReq = (req, fields, db) => record({ tenantId: req.user.tenantId, actorType: 'user', actorUserId: req.user.id, req, ...fields }, db);

module.exports = { record, fromReq, redact };
