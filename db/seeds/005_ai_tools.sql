-- Seed 005: the agent's tools. Descriptions and config are editable in the UI;
-- `parameters` (JSON schema) is owned by code. Required tools cannot be disabled
-- because the price guard and the handover rules depend on them. Idempotent.

INSERT INTO ai_tools (tenant_id, name, display_name, description, default_description, parameters, config, is_required, sort_order)
SELECT t.id, x.name, x.display_name, x.descr, x.descr, x.params::jsonb, x.config::jsonb, x.required, x.sort
FROM tenants t CROSS JOIN (VALUES
  ('get_pricing', 'Get pricing',
   'Look up the price range for a design category (package), optionally for a theme and occasion. Use this BEFORE mentioning any price. Never state a price that did not come from this tool or from a photo caption returned by send_photos.',
   '{"type":"object","properties":{"package_key":{"type":"string"},"theme":{"type":"string"},"occasion":{"type":"string"}},"required":["package_key"]}',
   '{}', true, 10),

  ('send_photos', 'Send design photos',
   'Send matching decoration photos from the BalloonsBuzz gallery. Use when the customer asks to see designs, names a theme, or gives a budget. Pass what you know: occasion, theme, budget range, style. Each photo is sent with its design name and price estimate. If nothing matches, the tool says so: tell the customer honestly and offer the closest option.',
   '{"type":"object","properties":{"occasion":{"type":"string"},"theme":{"type":"string"},"package_key":{"type":"string"},"budget_min":{"type":"number"},"budget_max":{"type":"number"},"style":{"type":"string"},"count":{"type":"integer","minimum":1,"maximum":5}}}',
   '{"default_count":3,"max_count":5,"budget_upsell_pct":15,"spread_across_packages":true}', false, 20),

  ('calculate_distance_charge', 'Calculate distance charge',
   'Calculate the travel charge from the BalloonsBuzz base in Miyapur to the venue. Needs the venue location pin (latitude/longitude) or a full address. If you have neither, call request_location first.',
   '{"type":"object","properties":{"latitude":{"type":"number"},"longitude":{"type":"number"},"address":{"type":"string"}}}',
   '{}', false, 30),

  ('check_negotiation_limit', 'Check discount request',
   'Call this whenever the customer asks for a discount or proposes a lower price. It returns whether the price is allowed, a counter-offer you may make, or that a human must take over. Never agree to any price this tool has not approved.',
   '{"type":"object","properties":{"quote_id":{"type":"string"},"requested_price":{"type":"number"}},"required":["quote_id","requested_price"]}',
   '{}', true, 40),

  ('create_booking', 'Create booking',
   'Create the booking once the customer has confirmed design, date, venue and final price. The price must be the approved quote price. Returns the booking code and the advance amount with payment details to share.',
   '{"type":"object","properties":{"quote_id":{"type":"string"},"event_date":{"type":"string","format":"date"},"event_time":{"type":"string"},"venue_address":{"type":"string"},"special_requests":{"type":"string"}},"required":["quote_id","event_date","venue_address"]}',
   '{}', false, 50),

  ('handover_to_human', 'Hand over to a human',
   'Pass the chat to the BalloonsBuzz team. Use when the customer asks for a person, when a discount is above the limit, when the venue is out of the service area, when the date is unavailable, or when you are unsure. After calling it, stop replying.',
   '{"type":"object","properties":{"reason":{"type":"string"},"summary":{"type":"string","description":"1-2 lines for the team: what the customer wants so far"}},"required":["reason"]}',
   '{}', true, 60),

  ('request_location', 'Request location pin',
   'Send the customer a WhatsApp button to share the venue location pin. Use before calculating the distance charge when you do not have coordinates.',
   '{"type":"object","properties":{"prompt_text":{"type":"string"}}}',
   '{"default_prompt_text":"Please share the venue location 📍"}', false, 70),

  ('update_lead', 'Save customer details',
   'Save what you learn about the event as soon as the customer says it: event date (ask it first), occasion, theme, venue, budget. Call it again whenever a detail changes. A same-day event closes the enquiry: follow the instruction it returns.',
   '{"type":"object","properties":{"occasion":{"type":"string"},"theme":{"type":"string"},"event_date":{"type":"string","format":"date"},"event_time":{"type":"string"},"venue_address":{"type":"string"},"budget_min":{"type":"number"},"budget_max":{"type":"number"},"notes":{"type":"string"}}}',
   '{}', false, 80),

  ('mark_lead_lost', 'Close a lost enquiry',
   'Mark the enquiry as lost when the customer says they already booked or got it done somewhere else (booked_elsewhere), or that they are not interested any more (not_interested). Pending follow-ups are cancelled. Then reply once, kindly, without pushing. Not for price objections or "I will tell you later".',
   '{"type":"object","properties":{"reason":{"type":"string","enum":["booked_elsewhere","not_interested"]},"details":{"type":"string"}},"required":["reason"]}',
   '{}', false, 85),

  ('schedule_followup', 'Schedule follow-up',
   'Schedule a friendly follow-up message, for example when the customer says "I will check and tell you" or asks you to message later. It is cancelled automatically if the customer replies first.',
   '{"type":"object","properties":{"send_at":{"type":"string","description":"ISO date-time in IST"},"message":{"type":"string"}},"required":["send_at","message"]}',
   '{"max_days_ahead":30,"quiet_hours":["21:30","08:30"]}', false, 90)
) AS x(name, display_name, descr, params, config, required, sort)
WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id, name) DO NOTHING;
