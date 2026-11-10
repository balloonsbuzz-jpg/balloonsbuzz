// Job name -> handler. Each handler receives (payload, job).
const { query } = require('../db/pool');
const { processWebhookEvent } = require('../whatsapp/inbound.service');
const { sendMessageJob } = require('../whatsapp/outbound.service');
const { autoResumeJob } = require('../conversations/handover.service');
const { getForSending } = require('../whatsapp/account.service');
const { RetryableError } = require('./jobs');
const graph = require('../whatsapp/graph');

/** Blue ticks on WhatsApp for a customer message (best effort). */
async function markReadJob({ message_id: id }) {
  const { rows } = await query(
    `SELECT m.wa_message_id, cv.whatsapp_account_id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE m.id = $1`, [id]);
  if (!rows[0]?.wa_message_id) return;
  const account = await getForSending(rows[0].whatsapp_account_id);
  try {
    await graph.markRead(account.phone_number_id, rows[0].wa_message_id, account.token);
  } catch (err) {
    if (err.retryable) throw new RetryableError(err.message);
    // permanent (e.g. message too old to mark read): nothing useful to retry
  }
}

module.exports = {
  process_webhook_event: processWebhookEvent,
  send_message: sendMessageJob,
  auto_resume: autoResumeJob,
  mark_read: markReadJob,
  gallery_sync: (...args) => require('../gallery/sync.job').gallerySyncJob(...args),
  ai_reply: (...args) => require('../agent/jobs').aiReplyJob(...args),
  send_followup: (...args) => require('../agent/jobs').sendFollowupJob(...args),
  staff_alert: (...args) => require('../automations/automations.service').staffAlertJob(...args),
  broadcast_start: (...args) => require('../broadcasts/broadcasts.service').startJob(...args),
  broadcast_batch: (...args) => require('../broadcasts/broadcasts.service').batchJob(...args),
};
