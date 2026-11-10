// Automatic messages about a booking (confirmation, advance reminder, event reminder,
// review request): the approved template for that purpose; otherwise a plain text if
// the customer wrote in the last 24 hours; otherwise nothing (and say why).
const { query } = require('../db/pool');
const { enqueueMessage } = require('../whatsapp/outbound.service');
const templates = require('../templates/templates.service');
const render = require('../templates/render');

async function bookingContext(bookingId) {
  const { rows: [b] } = await query(
    `SELECT b.*, ct.name AS contact_name, ct.phone AS contact_phone, ct.opted_in, p.name AS package_name,
            COALESCE(l.conversation_id, (SELECT cv2.id FROM conversations cv2 WHERE cv2.contact_id = b.contact_id ORDER BY cv2.last_message_at DESC NULLS LAST LIMIT 1)) AS conversation_id
       FROM bookings b JOIN contacts ct ON ct.id = b.contact_id JOIN packages p ON p.id = b.package_id
       LEFT JOIN leads l ON l.id = b.lead_id
      WHERE b.id = $1`, [bookingId]);
  if (!b) return null;
  const [{ rows: [cv] }, { rows: [biz] }] = await Promise.all([
    query(`SELECT id, handling_mode, whatsapp_account_id, is_sandbox, (last_inbound_at > now() - interval '24 hours') AS window_open
             FROM conversations WHERE id = $1`, [b.conversation_id]),
    query(`SELECT business_name, upi_vpa, upi_payee_name FROM business_settings WHERE tenant_id = $1`, [b.tenant_id]),
  ]);
  return { b, cv: cv || null, vals: render.values({ contact: { name: b.contact_name }, booking: b, business: biz || {} }) };
}

/**
 * @param {object} p
 * @param {string} p.bookingId
 * @param {string} p.purpose     templates.purpose
 * @param {(vals, booking) => string} p.text  fallback text inside the 24h window
 * @param {'system'|'bot'} [p.senderType]
 * @returns {Promise<{sent:boolean, via?:'template'|'text', template?:string, message_id?:string, reason?:string}>}
 */
async function sendBookingMessage({ bookingId, purpose, text, senderType = 'system' }) {
  const ctx = await bookingContext(bookingId);
  if (!ctx?.cv) return { sent: false, reason: 'No WhatsApp chat with this customer' };
  const { b, cv, vals } = ctx;
  const tpl = cv.whatsapp_account_id ? await templates.forPurpose(b.tenant_id, purpose, cv.whatsapp_account_id) : null;
  if (tpl) {
    const { content, missing } = render.buildContent(tpl, vals);
    if (missing.length) return { sent: false, reason: `Template ${tpl.name} has unmapped or empty fields: ${missing.join(', ')}` };
    const msg = await enqueueMessage({ tenantId: b.tenant_id, conversationId: cv.id, type: 'template', senderType, content: { ...content, preview_text: render.preview(tpl, vals) } });
    return { sent: true, via: 'template', template: tpl.name, message_id: msg.id };
  }
  if (cv.window_open) {
    const msg = await enqueueMessage({ tenantId: b.tenant_id, conversationId: cv.id, type: 'text', content: { text: text(vals, b) }, senderType });
    return { sent: true, via: 'text', message_id: msg.id };
  }
  return { sent: false, reason: `No approved "${purpose}" template and the 24-hour window is closed` };
}

module.exports = { sendBookingMessage, bookingContext };
