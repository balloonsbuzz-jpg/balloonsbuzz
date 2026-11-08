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

-- Provider/model/key are editable in the AI Agent screen. The API key comes from
-- DEEPSEEK_API_KEY in .env unless an admin saves one in the UI (stored encrypted).
-- Tools live in ai_tools (seed 005).
INSERT INTO ai_agent_config (
  tenant_id, provider, model, fallback_model, pricing_per_1m, system_prompt,
  handover_message, out_of_hours_message, settings)
SELECT t.id,
       'deepseek',
       'deepseek-chat',
       'deepseek-reasoner',
       '{"input":0.27,"cached_input":0.07,"output":1.10,"currency":"USD"}'::jsonb,  -- same rates Whapter tracks; editable
       'PLACEHOLDER: replaced by prompts/balloonsbuzz-agent.md in Phase 4.',
       'Sure! Connecting you with our team now 😊 Someone will reply here shortly.',
       'Thanks for messaging BalloonsBuzz 🎈 Our team is offline right now. We''ll get back to you first thing!',
       '{"language":"en","currency_symbol":"₹"}'::jsonb
FROM tenants t WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id) DO NOTHING;
