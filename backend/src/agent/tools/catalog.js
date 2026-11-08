// Code-side registry of the agent's tools. The DB (ai_tools) holds what admins
// may edit (description, on/off, config); this file defines which tools exist,
// which settings each accepts, and (later, M6) their implementations.
const { z } = require('zod');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');

const TOOL_CONFIG_SCHEMAS = {
  get_pricing: z.object({}).strict(),
  send_photos: z.object({
    default_count: z.number().int().min(1).max(5),
    max_count: z.number().int().min(1).max(5),
    budget_upsell_pct: z.number().min(0).max(50),
    spread_across_packages: z.boolean(),
  }).strict().refine((c) => c.default_count <= c.max_count, { message: 'default_count cannot exceed max_count', path: ['default_count'] }),
  calculate_distance_charge: z.object({}).strict(),
  check_negotiation_limit: z.object({}).strict(),
  create_booking: z.object({}).strict(),
  handover_to_human: z.object({}).strict(),
  request_location: z.object({ default_prompt_text: z.string().trim().min(1).max(200) }).strict(),
  update_lead: z.object({}).strict(),
  schedule_followup: z.object({
    max_days_ahead: z.number().int().min(1).max(90),
    quiet_hours: z.tuple([hhmm, hhmm]),
  }).strict(),
};

const TOOL_NAMES = Object.keys(TOOL_CONFIG_SCHEMAS);

module.exports = { TOOL_CONFIG_SCHEMAS, TOOL_NAMES };
