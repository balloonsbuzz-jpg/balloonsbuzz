// The ONE place that changes who is handling a conversation (bot | human | paused).
// Every switch is recorded in handover_events + audit_log and pushed to dashboards.
const { query, withTx } = require('../db/pool');
const { notFound } = require('../lib/errors');
const { enqueue } = require('../queue/jobs');
const audit = require('../services/audit.service');
const bus = require('../realtime/bus');

// Agent-initiated switches mean someone is already on it: not "needs human".
const AGENT_TRIGGERS = new Set(['agent_takeover', 'agent_pause', 'agent_reply']);

/**
 * @param {object} c pg client inside a transaction
 * @param {object} p { tenantId, conversationId, to:'bot'|'human'|'paused', trigger, actorUserId?, reason?, metadata?, resumeAt?: Date }
 * @returns updated conversation row (unchanged row when already in that mode)
 */
async function switchMode(c, p) {
  const { rows } = await c.query(
    `SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [p.conversationId, p.tenantId]);
  const conv = rows[0];
  if (!conv) throw notFound('Conversation not found');
  const from = conv.handling_mode;

  if (from === p.to) {
    // Same mode: an agent re-taking a chat still clears "needs human" and assigns it.
    if (p.to !== 'bot' && AGENT_TRIGGERS.has(p.trigger) && (conv.needs_human || !conv.assigned_user_id)) {
      const { rows: [u] } = await c.query(
        `UPDATE conversations SET needs_human = false, assigned_user_id = COALESCE(assigned_user_id, $2) WHERE id = $1 RETURNING *`,
        [conv.id, p.actorUserId || null]);
      await bus.publish({ tenantId: p.tenantId, type: 'conversation.updated', conversation_id: conv.id }, c);
      return u;
    }
    return conv;
  }

  const toBot = p.to === 'bot';
  const { rows: [next] } = await c.query(
    `UPDATE conversations
        SET handling_mode = $2,
            handover_at = CASE WHEN $2 = 'bot' THEN handover_at ELSE now() END,
            handover_reason = CASE WHEN $2 = 'bot' THEN handover_reason ELSE $3 END,
            needs_human = $4,
            assigned_user_id = CASE WHEN $5::uuid IS NOT NULL AND $2 <> 'bot' THEN $5::uuid ELSE assigned_user_id END,
            bot_resume_at = $6,
            bot_stuck_count = CASE WHEN $2 = 'bot' THEN 0 ELSE bot_stuck_count END
      WHERE id = $1 RETURNING *`,
    [conv.id, p.to, p.reason || p.trigger, !toBot && !AGENT_TRIGGERS.has(p.trigger),
      AGENT_TRIGGERS.has(p.trigger) ? p.actorUserId || null : null, toBot ? null : p.resumeAt || null]);

  await c.query(
    `INSERT INTO handover_events (tenant_id, conversation_id, from_mode, to_mode, trigger, reason, actor_user_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [p.tenantId, conv.id, from, p.to, p.trigger, p.reason || null, p.actorUserId || null,
      JSON.stringify({ ...(p.metadata || {}), ...(p.resumeAt ? { resume_at: p.resumeAt } : {}) })]);

  await audit.record({
    tenantId: p.tenantId, actorType: p.actorUserId ? 'user' : (p.trigger === 'auto_resume' || p.trigger === 'system' ? 'system' : 'bot'),
    actorUserId: p.actorUserId || null, action: 'conversation.handover', entityType: 'conversation', entityId: conv.id,
    before: { handling_mode: from }, after: { handling_mode: p.to, trigger: p.trigger, reason: p.reason || null },
  }, c);

  if (p.resumeAt && !toBot) {
    await enqueue({ tenantId: p.tenantId, name: 'auto_resume', payload: { conversation_id: conv.id }, runAt: p.resumeAt,
      uniqueKey: `auto_resume:${conv.id}:${new Date(p.resumeAt).getTime()}` }, c);
  }
  await bus.publish({ tenantId: p.tenantId, type: 'conversation.updated', conversation_id: conv.id, handling_mode: p.to }, c);
  return next;
}

const switchModeTx = (p) => withTx((c) => switchMode(c, p));

/** Worker handler: resume the bot if the timer is still due (an agent may have changed it since). */
async function autoResumeJob({ conversation_id: id }) {
  // Compare in SQL (one clock): the app server's clock can drift from the database's.
  const { rows } = await query(
    `SELECT tenant_id, handling_mode, bot_resume_at, bot_resume_at <= now() + interval '1 second' AS due
       FROM conversations WHERE id = $1`, [id]);
  const conv = rows[0];
  if (!conv || conv.handling_mode === 'bot' || !conv.bot_resume_at) return;
  if (!conv.due) return;   // timer moved later; a newer job will handle it
  await switchModeTx({ tenantId: conv.tenant_id, conversationId: id, to: 'bot', trigger: 'auto_resume', reason: 'Resume timer elapsed' });
}

/**
 * The guard the AI runtime (M6) calls before generating AND again before sending.
 * The bot may reply only when the conversation is in bot mode and the bot is enabled.
 */
async function canBotReply(conversationId) {
  const { rows } = await query(
    `SELECT cv.handling_mode, a.is_enabled
       FROM conversations cv LEFT JOIN ai_agent_config a ON a.tenant_id = cv.tenant_id
      WHERE cv.id = $1`, [conversationId]);
  const r = rows[0];
  if (!r) return { allowed: false, reason: 'not_found' };
  if (r.handling_mode !== 'bot') return { allowed: false, reason: `handling_mode_${r.handling_mode}` };
  if (r.is_enabled === false) return { allowed: false, reason: 'bot_disabled' };
  return { allowed: true };
}

/** Case-insensitive whole-word/phrase match against the configured handover keywords. */
function matchesHandoverKeyword(text, keywords = []) {
  if (!text) return null;
  const t = ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;
  return keywords.find((k) => k && t.includes(` ${String(k).toLowerCase().trim()} `)) || null;
}

module.exports = { switchMode, switchModeTx, autoResumeJob, canBotReply, matchesHandoverKeyword };
