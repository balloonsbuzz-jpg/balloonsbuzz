DELETE FROM ai_tools WHERE name = 'mark_lead_lost';

UPDATE ai_tools SET
  description = CASE WHEN description = default_description THEN x.descr ELSE description END,
  default_description = x.descr,
  parameters = x.params::jsonb
FROM (VALUES
  ('update_lead',
   'Save what you learn about the event as soon as the customer says it: occasion, theme, event date, venue, guest count, budget. Call it again whenever a detail changes.',
   '{"type":"object","properties":{"occasion":{"type":"string"},"theme":{"type":"string"},"event_date":{"type":"string","format":"date"},"event_time":{"type":"string"},"venue_address":{"type":"string"},"guest_count":{"type":"integer"},"budget_min":{"type":"number"},"budget_max":{"type":"number"},"notes":{"type":"string"}}}'),
  ('create_booking',
   'Create the booking once the customer has confirmed design, date, venue and final price. The price must be the approved quote price. Returns the booking code and the advance amount with payment details to share.',
   '{"type":"object","properties":{"quote_id":{"type":"string"},"event_date":{"type":"string","format":"date"},"event_time":{"type":"string"},"venue_address":{"type":"string"},"guest_count":{"type":"integer"},"special_requests":{"type":"string"}},"required":["quote_id","event_date","venue_address"]}')
) AS x(name, descr, params)
WHERE ai_tools.name = x.name;
