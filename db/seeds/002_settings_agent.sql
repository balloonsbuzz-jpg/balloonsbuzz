-- Seed 002: business settings and AI agent config. Idempotent.
-- TODO(client): base pin, max service km, advance %, working hours, staff phones, UPI.
-- The WhatsApp account row is created from the Settings screen once Meta access exists.

INSERT INTO business_settings (
  tenant_id, business_name, base_address, base_lat, base_lng, road_factor, max_service_km,
  advance_type, advance_value, min_lead_time_hours, working_hours, staff_alert_phones, extra)
SELECT t.id,
       'BalloonsBuzz',
       'Beside Reliance Digital, Indira Nagar Colony, Miyapur, Hyderabad, Telangana 500049',
       NULL, NULL,          -- TODO(client): exact base pin; distance tool refuses to run until set
       1.30,
       NULL,                -- TODO(client): max service distance
       'percent', NULL,     -- TODO(client): advance %
       24,
       '{"mon":[["09:00","21:00"]],"tue":[["09:00","21:00"]],"wed":[["09:00","21:00"]],
         "thu":[["09:00","21:00"]],"fri":[["09:00","21:00"]],"sat":[["09:00","21:00"]],
         "sun":[["09:00","21:00"]]}'::jsonb,   -- TODO(client): placeholder hours
       '{}',
       '{"whatsapp_display_phone":"919392534625","instagram":"balloonsbuzz_miyapur","todo":"confirm all settings with client"}'::jsonb
FROM tenants t WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO ai_agent_config (
  tenant_id, provider, model, system_prompt, tools_enabled, handover_message, out_of_hours_message, settings)
SELECT t.id,
       'anthropic',
       'claude-sonnet-5-5',   -- configurable in the agent settings screen
       'PLACEHOLDER: replaced by prompts/balloonsbuzz-agent.md in Phase 4.',
       '["get_pricing","send_photos","calculate_distance_charge","check_negotiation_limit",
         "create_booking","handover_to_human","request_location","update_lead","schedule_followup"]'::jsonb,
       'Sure! Connecting you with our team now 😊 Someone will reply here shortly.',
       'Thanks for messaging BalloonsBuzz 🎈 Our team is offline right now. We''ll get back to you first thing!',
       '{"language":"en","currency_symbol":"₹"}'::jsonb
FROM tenants t WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id) DO NOTHING;
