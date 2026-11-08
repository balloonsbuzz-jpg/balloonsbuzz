-- Seed 001: the BalloonsBuzz tenant and its system roles. Idempotent.
-- No users are seeded (no passwords in source control); the owner account is
-- created with `npm run create-owner` (M2).

INSERT INTO tenants (slug, name, timezone, currency)
VALUES ('balloonsbuzz', 'BalloonsBuzz', 'Asia/Kolkata', 'INR')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO roles (tenant_id, key, name, permissions, is_system)
SELECT t.id, r.key, r.name, r.permissions::jsonb, true
FROM tenants t
CROSS JOIN (VALUES
  ('owner', 'Owner', '["*"]'),
  ('admin', 'Admin', '["dashboard:read","inbox:read","inbox:write","handover:write","contacts:read","contacts:write",
                      "leads:read","leads:write","bookings:read","bookings:write","payments:write",
                      "gallery:read","gallery:write","pricing:read","pricing:write","agent:read","agent:write",
                      "templates:read","templates:write","broadcasts:read","broadcasts:write",
                      "automations:read","automations:write","analytics:read","users:read","users:write","audit:read",
                      "settings:read","settings:write"]'),
  ('agent', 'Agent', '["dashboard:read","inbox:read","inbox:write","handover:write","contacts:read","contacts:write",
                      "leads:read","leads:write","bookings:read","bookings:write","gallery:read","pricing:read",
                      "templates:read"]')
) AS r(key, name, permissions)
WHERE t.slug = 'balloonsbuzz'
ON CONFLICT (tenant_id, key) DO NOTHING;
