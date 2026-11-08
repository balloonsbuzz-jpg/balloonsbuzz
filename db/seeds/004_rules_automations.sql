-- Seed 004: pricing rules, negotiation rule, distance slabs, default automations, canned replies.
-- EVERY amount here is a placeholder => price_confirmed = false / TODO(client).
-- Pricing rules only exist where the Drive folder gives a price; other packages are
-- quoted from the photo the customer picks (gallery item price range).

-- ── pricing_rules (base price per package from folder names) ─
INSERT INTO pricing_rules (tenant_id, package_id, occasion_id, rule_type, price_min, price_max, priority, notes)
SELECT p.tenant_id, p.id, o.id, r.rule_type, r.pmin, r.pmax, r.priority, r.notes
FROM (VALUES
  ('basic',            NULL,          'base_price', 3500,  5000,  0, 'TODO(client): from folder BASIC (3.5-5k)'),
  ('balloon_bunches',  NULL,          'base_price', 3500,  5000,  0, 'TODO(client): from folder name'),
  ('car_trunk',        NULL,          'base_price', 2500,  3500,  0, 'TODO(client): from folder name'),
  ('wall_decor',       'baby_shower', 'base_price', 4000,  4500, 10, 'TODO(client): baby shower/wall (4k-4.5k)'),
  ('ring_frame',       'baby_shower', 'base_price', 5500,  9000, 10, 'TODO(client): baby shower ring frame 5.5k-7k, ring baby shower 6k-9k'),
  ('semi_arch',        NULL,          'base_price', 6000,  10000, 0, 'TODO(client): from folder name'),
  ('moon_theme',       NULL,          'base_price', 7500,  10000, 0, 'TODO(client): from folder name'),
  ('bunch_unit',       NULL,          'unit_price', 40,    40,    0, 'TODO(client): ₹40 per bunch, min quantity?')
) AS r(package_key, occasion_key, rule_type, pmin, pmax, priority, notes)
JOIN packages p ON p.key = r.package_key AND p.deleted_at IS NULL
JOIN tenants t ON t.id = p.tenant_id AND t.slug = 'balloonsbuzz'
LEFT JOIN occasions o ON o.key = r.occasion_key AND o.tenant_id = p.tenant_id AND o.deleted_at IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_rules x
  WHERE x.package_id = p.id AND x.rule_type = r.rule_type
    AND x.occasion_id IS NOT DISTINCT FROM o.id AND x.theme_id IS NULL);

-- ── negotiation: one global rule (placeholder 10% / 2 rounds) ─
INSERT INTO negotiation_rules (tenant_id, scope, max_discount_pct, concession_step_pct, max_rounds, notes)
SELECT t.id, 'global', 10.00, 5.00, 2, 'TODO(client): confirm max discount per package and overall'
FROM tenants t
WHERE t.slug = 'balloonsbuzz'
  AND NOT EXISTS (SELECT 1 FROM negotiation_rules n WHERE n.tenant_id = t.id AND n.scope = 'global' AND n.is_active);

-- ── distance slabs (placeholder bands from the Miyapur base) ─
INSERT INTO distance_slabs (tenant_id, min_km, max_km, charge_type, amount, label)
SELECT t.id, s.min_km, s.max_km, s.charge_type, s.amount, s.label
FROM tenants t CROSS JOIN (VALUES
  (0::numeric,  5::numeric,  'free',            0::numeric,  'Within 5 km - free'),
  (5,           10,          'flat',            300,         '5-10 km'),
  (10,          20,          'flat',            600,         '10-20 km'),
  (20,          35,          'flat',            1000,        '20-35 km'),
  (35,          NULL,        'not_serviceable', 0,           'Beyond 35 km - team will confirm')
) AS s(min_km, max_km, charge_type, amount, label)
WHERE t.slug = 'balloonsbuzz'
  AND NOT EXISTS (SELECT 1 FROM distance_slabs d WHERE d.tenant_id = t.id);

-- ── default automations (all OFF until the client approves wording + templates) ──
INSERT INTO automations (tenant_id, key, name, trigger_type, trigger_config, action_type, action_config, only_when_bot, is_active)
SELECT t.id, a.key, a.name, a.trigger_type, a.trigger_config::jsonb, a.action_type, a.action_config::jsonb, a.only_when_bot, false
FROM tenants t CROSS JOIN (VALUES
  ('quote_nudge_3h',     'Nudge 3h after quote with no reply', 'quote_no_reply',    '{"delay_minutes":180}',
     'send_text', '{"text":"Hi {{contact.first_name}} 👋 Did you get a chance to look at the designs? Happy to help you pick one 🎈"}', true),
  ('advance_reminder',   'Advance pending reminder (12h)',     'advance_pending',   '{"delay_minutes":720}',
     'send_template', '{"template_purpose":"advance_reminder"}', false),
  ('booking_confirmed',  'Booking confirmation',               'booking_confirmed', '{}',
     'send_template', '{"template_purpose":"booking_confirmation"}', false),
  ('event_reminder',     'Event reminder (1 day before)',      'event_reminder',    '{"offset_hours":-24}',
     'send_template', '{"template_purpose":"event_reminder"}', false),
  ('review_request',     'Review request (day after event)',   'post_event_review', '{"offset_hours":24}',
     'send_template', '{"template_purpose":"review_request"}', false),
  ('handover_staff_alert','Alert staff on handover',           'handover_requested','{}',
     'notify_staff', '{"channels":["inbox","whatsapp_template"],"template_purpose":"handover_alert"}', false),
  ('lead_stale_48h',     'Mark lead stale after 48h silence',  'lead_stale',        '{"delay_minutes":2880}',
     'set_lead_status', '{"status":"stale"}', true)
) AS a(key, name, trigger_type, trigger_config, action_type, action_config, only_when_bot)
WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ── canned replies for agents ────────────────────────────────
INSERT INTO canned_replies (tenant_id, shortcut, title, body)
SELECT t.id, c.shortcut, c.title, c.body
FROM tenants t CROSS JOIN (VALUES
  ('hi',       'Greeting',          'Hi! 🎈 This is BalloonsBuzz. How can I help you today?'),
  ('location', 'Ask for location',  'Could you share the venue location pin? 📍 It helps us calculate travel charges.'),
  ('advance',  'Advance request',   'To confirm your date, please pay the advance. I''ll share the payment details now 🙏'),
  ('thanks',   'Thank you',         'Thank you so much! 💛 Your booking is confirmed. See you on the big day 🎉'),
  ('bot',      'Hand back to bot',  'I''m handing you back to our assistant, who can share designs and prices anytime 😊')
) AS c(shortcut, title, body)
WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id, shortcut) DO NOTHING;
