// Job name -> handler. Each handler receives (payload, job).
const { processWebhookEvent } = require('../whatsapp/inbound.service');
const { sendMessageJob } = require('../whatsapp/outbound.service');

module.exports = {
  process_webhook_event: processWebhookEvent,
  send_message: sendMessageJob,
};
