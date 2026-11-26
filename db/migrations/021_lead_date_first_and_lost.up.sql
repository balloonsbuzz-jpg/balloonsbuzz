-- 021 The bot asks the event date first, no longer asks the guest count, and can close an
-- enquiry as lost (booked elsewhere / not interested). Descriptions an admin has edited are kept.

UPDATE ai_tools SET
  description = CASE WHEN description = default_description THEN x.descr ELSE description END,
  default_description = x.descr,
  parameters = x.params::jsonb
FROM (VALUES
  ('update_lead',
   'Save what you learn about the event as soon as the customer says it: event date (ask it first), occasion, theme, venue, budget. Call it again whenever a detail changes. A same-day event closes the enquiry: follow the instruction it returns.',
   '{"type":"object","properties":{"occasion":{"type":"string"},"theme":{"type":"string"},"event_date":{"type":"string","format":"date"},"event_time":{"type":"string"},"venue_address":{"type":"string"},"budget_min":{"type":"number"},"budget_max":{"type":"number"},"notes":{"type":"string"}}}'),
  ('create_booking',
   'Create the booking once the customer has confirmed design, date, venue and final price. The price must be the approved quote price. Returns the booking code and the advance amount with payment details to share.',
   '{"type":"object","properties":{"quote_id":{"type":"string"},"event_date":{"type":"string","format":"date"},"event_time":{"type":"string"},"venue_address":{"type":"string"},"special_requests":{"type":"string"}},"required":["quote_id","event_date","venue_address"]}')
) AS x(name, descr, params)
WHERE ai_tools.name = x.name;

INSERT INTO ai_tools (tenant_id, name, display_name, description, default_description, parameters, config, is_required, sort_order)
SELECT t.id, 'mark_lead_lost', 'Close a lost enquiry', x.descr, x.descr,
  '{"type":"object","properties":{"reason":{"type":"string","enum":["booked_elsewhere","not_interested"]},"details":{"type":"string"}},"required":["reason"]}'::jsonb,
  '{}'::jsonb, false, 85
FROM tenants t CROSS JOIN (VALUES (
  'Mark the enquiry as lost when the customer says they already booked or got it done somewhere else (booked_elsewhere), or that they are not interested any more (not_interested). Pending follow-ups are cancelled. Then reply once, kindly, without pushing. Not for price objections or "I will tell you later".'
)) AS x(descr)
WHERE EXISTS (SELECT 1 FROM ai_tools a WHERE a.tenant_id = t.id)
ON CONFLICT (tenant_id, name) DO NOTHING;
