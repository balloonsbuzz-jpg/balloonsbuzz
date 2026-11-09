// Builds Cloud API message payloads from our message content, validating
// WhatsApp's limits up front so bad messages fail fast instead of at Meta.
const { badRequest } = require('../lib/errors');

const LIMITS = { text: 4096, caption: 1024, buttonTitle: 20, buttons: 3, listRows: 10, interactiveBody: 1024 };

function need(cond, field, message) {
  if (!cond) throw badRequest('Invalid message', [{ field, message }]);
}

/**
 * @param {string} to digits-only phone
 * @param {string} type text|image|video|document|audio|template|buttons|list|location_request
 * @param {object} content
 * @param {string} [replyToWamid]
 */
function buildPayload(to, type, content = {}, replyToWamid) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (replyToWamid) base.context = { message_id: replyToWamid };

  switch (type) {
    case 'text': {
      const body = String(content.text ?? '');
      need(body.trim().length > 0, 'text', 'Message is empty');
      need(body.length <= LIMITS.text, 'text', `Max ${LIMITS.text} characters`);
      return { ...base, type: 'text', text: { body, preview_url: !!content.preview_url } };
    }
    case 'image': case 'video': case 'document': case 'audio': {
      need(/^https:\/\//.test(content.link || ''), 'link', 'Media must be a public https URL');
      need(!content.caption || content.caption.length <= LIMITS.caption, 'caption', `Max ${LIMITS.caption} characters`);
      const media = { link: content.link };
      if (content.caption && type !== 'audio') media.caption = content.caption;
      if (type === 'document' && content.filename) media.filename = content.filename;
      return { ...base, type, [type]: media };
    }
    case 'template': {
      need(/^[a-z0-9_]{1,512}$/.test(content.name || ''), 'name', 'Template name is required');
      return {
        ...base, type: 'template',
        template: { name: content.name, language: { code: content.language || 'en' }, ...(content.components?.length ? { components: content.components } : {}) },
      };
    }
    case 'buttons': {
      const buttons = content.buttons || [];
      need(buttons.length >= 1 && buttons.length <= LIMITS.buttons, 'buttons', 'Use 1 to 3 buttons');
      need(buttons.every((b) => b.title && b.title.length <= LIMITS.buttonTitle), 'buttons', `Button titles max ${LIMITS.buttonTitle} characters`);
      need(content.text && content.text.length <= LIMITS.interactiveBody, 'text', 'Body text is required (max 1024)');
      return {
        ...base, type: 'interactive',
        interactive: {
          type: 'button', body: { text: content.text },
          action: { buttons: buttons.map((b, i) => ({ type: 'reply', reply: { id: String(b.id || `btn_${i + 1}`), title: b.title } })) },
        },
      };
    }
    case 'list': {
      const rows = (content.sections || []).flatMap((s) => s.rows || []);
      need(rows.length >= 1 && rows.length <= LIMITS.listRows, 'sections', 'Use 1 to 10 rows');
      need(content.text && content.button, 'text', 'Body text and button label are required');
      return {
        ...base, type: 'interactive',
        interactive: { type: 'list', body: { text: content.text }, action: { button: content.button.slice(0, 20), sections: content.sections } },
      };
    }
    case 'location_request': {
      return {
        ...base, type: 'interactive',
        interactive: { type: 'location_request_message', body: { text: content.text || 'Please share the venue location 📍' }, action: { name: 'send_location' } },
      };
    }
    default:
      throw badRequest(`Unsupported message type: ${type}`);
  }
}

/** Our messages.message_type + body for a given outbound type/content. */
function storedShape(type, content) {
  switch (type) {
    case 'text': return { message_type: 'text', body: content.text };
    case 'image': case 'video': case 'document': case 'audio': return { message_type: type, body: content.caption || null };
    case 'template': return { message_type: 'template', body: content.preview_text || `Template: ${content.name}` };
    case 'buttons': case 'list': case 'location_request': return { message_type: 'interactive', body: content.text || null };
    default: return { message_type: 'unsupported', body: null };
  }
}

module.exports = { buildPayload, storedShape, LIMITS };
