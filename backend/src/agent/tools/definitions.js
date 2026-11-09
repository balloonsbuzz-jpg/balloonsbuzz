// What each tool accepts. The model sees these JSON schemas; the runtime validates
// the model's arguments with the matching zod schema before running a tool.
// Descriptions come from the database (editable in AI → Tools).
const { z } = require('zod');

const str = (max = 200) => z.string().trim().min(1).max(max);
const money = z.coerce.number().min(0).max(10_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const TOOLS = {
  get_pricing: {
    schema: z.object({
      package_key: str(60).optional(),
      photo_id: z.string().uuid().optional(),
      theme: str(60).optional(),
      occasion: str(60).optional(),
      addons: z.array(z.object({ package_key: str(60), quantity: z.coerce.number().int().min(1).max(1000).default(1) })).max(5).optional(),
    }).refine((a) => a.package_key || a.photo_id, 'Give package_key or photo_id'),
    parameters: {
      type: 'object',
      properties: {
        package_key: { type: 'string', description: 'Design category key from the context list, e.g. two_frames' },
        photo_id: { type: 'string', description: 'id of a photo already sent, when the customer picked one' },
        theme: { type: 'string' },
        occasion: { type: 'string' },
        addons: { type: 'array', items: { type: 'object', properties: { package_key: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } }, required: ['package_key'] } },
      },
    },
  },
  send_photos: {
    schema: z.object({
      occasion: str(60).optional(), theme: str(60).optional(), package_key: str(60).optional(),
      budget_min: money.optional(), budget_max: money.optional(), style: str(30).optional(),
      count: z.coerce.number().int().min(1).max(5).optional(),
    }),
    parameters: {
      type: 'object',
      properties: {
        occasion: { type: 'string' }, theme: { type: 'string' }, package_key: { type: 'string' },
        budget_min: { type: 'number' }, budget_max: { type: 'number' }, style: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
  },
  calculate_distance_charge: {
    schema: z.object({
      latitude: z.coerce.number().min(-90).max(90).optional(),
      longitude: z.coerce.number().min(-180).max(180).optional(),
      address: str(300).optional(),
    }),
    parameters: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, address: { type: 'string' } } },
  },
  check_negotiation_limit: {
    schema: z.object({ quote_id: z.string().uuid().optional(), requested_price: money }),
    parameters: {
      type: 'object',
      properties: { quote_id: { type: 'string' }, requested_price: { type: 'number', description: 'The total the customer wants to pay, in rupees' } },
      required: ['requested_price'],
    },
  },
  create_booking: {
    schema: z.object({
      quote_id: z.string().uuid().optional(), event_date: date.optional(), event_time: str(20).optional(),
      venue_address: str(300).optional(), guest_count: z.coerce.number().int().min(1).max(10000).optional(), special_requests: str(500).optional(),
    }),
    parameters: {
      type: 'object',
      properties: {
        quote_id: { type: 'string' }, event_date: { type: 'string', format: 'date' }, event_time: { type: 'string' },
        venue_address: { type: 'string' }, guest_count: { type: 'integer' }, special_requests: { type: 'string' },
      },
    },
  },
  handover_to_human: {
    schema: z.object({ reason: str(300), summary: str(600).optional() }),
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' }, summary: { type: 'string', description: '1-2 lines for the team: what the customer wants so far' } },
      required: ['reason'],
    },
  },
  request_location: {
    schema: z.object({ prompt_text: str(200).optional() }),
    parameters: { type: 'object', properties: { prompt_text: { type: 'string' } } },
  },
  update_lead: {
    schema: z.object({
      occasion: str(60).optional(), theme: str(100).optional(), event_date: date.optional(), event_time: str(20).optional(),
      venue_address: str(300).optional(), guest_count: z.coerce.number().int().min(1).max(10000).optional(),
      budget_min: money.optional(), budget_max: money.optional(), notes: str(500).optional(),
    }),
    parameters: {
      type: 'object',
      properties: {
        occasion: { type: 'string' }, theme: { type: 'string' }, event_date: { type: 'string', format: 'date' }, event_time: { type: 'string' },
        venue_address: { type: 'string' }, guest_count: { type: 'integer' }, budget_min: { type: 'number' }, budget_max: { type: 'number' }, notes: { type: 'string' },
      },
    },
  },
  schedule_followup: {
    schema: z.object({ send_at: z.string().min(10).max(40), message: str(600) }),
    parameters: {
      type: 'object',
      properties: { send_at: { type: 'string', description: 'ISO date-time, e.g. 2026-11-12T11:00:00+05:30' }, message: { type: 'string' } },
      required: ['send_at', 'message'],
    },
  },
};

/** OpenAI-format tool list for the enabled DB rows (descriptions are admin-editable). */
function toolSpecs(rows) {
  return rows
    .filter((r) => r.is_enabled && TOOLS[r.name])
    .map((r) => ({ type: 'function', function: { name: r.name, description: r.description, parameters: TOOLS[r.name].parameters } }));
}

module.exports = { TOOLS, toolSpecs };
