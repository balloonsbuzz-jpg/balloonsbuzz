// Worker jobs for the agent: AI replies (debounced per conversation) and bot follow-ups.
const { env } = require('../config/env');
const { query } = require('../db/pool');
const logger = require('../lib/logger');
const { enqueue, RetryableError } = require('../queue/jobs');
const { enqueueMessage } = require('../whatsapp/outbound.service');
const { runTurn, markStuck } = require('./runtime');
const { LlmError } = require('./provider');

/**
 * Customers often send 2-3 short messages in a row: wait a moment and answer them together.
 * Only one ai_reply job per conversation can be queued or running (unique key).
 */
async function scheduleAiReply({ tenantId, conversationId, messageId }, db) {
  return enqueue({
    tenantId, name: 'ai_reply', payload: { conversation_id: conversationId, message_id: messageId },
    delayMs: env.AI_DEBOUNCE_MS, uniqueKey: `ai_reply:${conversationId}`, maxAttempts: 2, priority: 5,
  }, db);
}

async function aiReplyJob({ conversation_id: conversationId, message_id: messageId }, job) {
  for (let turn = 0; turn < 3; turn += 1) {
    const { rows: [{ t: turnStart }] } = await query('SELECT now() AS t');
    try {
      await runTurn({ tenantId: job.tenant_id, conversationId, triggerMessageId: messageId });
    } catch (err) {
      if (err instanceof LlmError && err.retryable && job.attempts < job.max_attempts) throw new RetryableError(err.message, { delayMs: 5000 });
      logger.error('AI reply failed; handing over', { conversationId, error: err.message });
      await markStuck(job.tenant_id, conversationId, `The AI could not reply (${String(err.message).slice(0, 120)})`);
      return;
    }
    // Messages that arrived while we were answering (this job's unique key blocked a new one): answer them too.
    const { rows: [{ n }] } = await query(
      `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'inbound' AND created_at > $2`, [conversationId, turnStart]);
    if (!n) return;
  }
}

/** Bot-scheduled follow-up: skipped if the customer replied, a person has the chat, or WhatsApp's 24h window closed. */
async function sendFollowupJob({ followup_id: id }) {
  const { rows: [f] } = await query(
    `SELECT f.*, cv.handling_mode, (cv.last_inbound_at > now() - interval '24 hours') AS window_open,
            EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = f.conversation_id AND m.direction = 'inbound' AND m.created_at > f.created_at) AS replied
       FROM followups f JOIN conversations cv ON cv.id = f.conversation_id WHERE f.id = $1`, [id]);
  if (!f || f.status !== 'pending') return;
  const skip = async (status, reason) => query(
    `UPDATE followups SET status = $2, cancel_reason = $3, cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() END WHERE id = $1`, [id, status, reason]);
  if (f.cancel_on_reply && f.replied) return skip('cancelled', 'customer replied');
  if (f.handling_mode !== 'bot') return skip('skipped', 'a team member has the chat');
  if (!f.window_open) return skip('skipped', '24-hour window closed (needs a template, M8)');
  const msg = await enqueueMessage({ tenantId: f.tenant_id, conversationId: f.conversation_id, type: 'text', content: { text: f.content.text }, senderType: 'bot' });
  await query(`UPDATE followups SET status = 'sent', sent_at = now(), message_id = $2, attempts = attempts + 1 WHERE id = $1`, [id, msg.id]);
  return undefined;
}

/** A reply from the customer cancels pending follow-ups that should only go out on silence. */
async function cancelFollowupsOnReply(conversationId, db = { query }) {
  await db.query(
    `UPDATE followups SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'customer replied'
      WHERE conversation_id = $1 AND status = 'pending' AND cancel_on_reply`, [conversationId]);
}

module.exports = { scheduleAiReply, aiReplyJob, sendFollowupJob, cancelFollowupsOnReply };
