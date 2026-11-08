# Database

PostgreSQL 15 + pgvector (the same engine as Whapter), accessed with plain `pg`. No ORM, no PostgREST.

## Commands

```bash
cp .env.example .env          # set a local password
npm run db:up                 # local Postgres on 127.0.0.1:55432 (docker-compose.db.yml)
npm run migrate               # apply pending migrations
npm run seed                  # BalloonsBuzz tenant, roles, catalog, placeholder rules (idempotent)
npm run migrate:status
npm run migrate:down          # roll back the last migration (or: node db/migrate.js down all)
npm run db:reset              # down all + up + seed (refused when NODE_ENV=production)
npm run db:snapshot           # regenerate db/schema.sql
npm run test:db               # 32 tests, each file in its own throwaway database
```

Change the schema by adding `NNN_name.up.sql` + `NNN_name.down.sql`. **Never edit an applied migration**; the runner detects checksum changes and refuses to continue.

## Conventions (mirroring Whapter)

- `id uuid DEFAULT gen_random_uuid()`. `created_at`/`updated_at timestamptz` with the `update_updated_at_column()` trigger.
- Status values are `text` + `CHECK (col = ANY (ARRAY[...]))`, not native enums.
- `tenant_id → tenants(id) ON DELETE CASCADE` on **every** table (single seeded tenant: `balloonsbuzz`).
- Names: `idx_<table>_<cols>`, `uq_<table>_<cols>`.
- Money is `numeric(12,2)` in ₹. Phone numbers are digits-only E.164 without `+` (for example `919392534625`).
- `deleted_at` soft delete only on users, contacts, occasions, packages, themes, gallery assets, leads, bookings and broadcasts.
- Every FK column leads an index (a test enforces this).

## Map

| Migration | Tables |
|---|---|
| 001 foundation | tenants, roles, users, sessions |
| 002 settings | whatsapp_accounts, business_settings, ai_agent_config, ai_agent_config_versions, knowledge_snippets |
| 003 catalog | occasions, packages, themes, theme_aliases, pricing_rules, negotiation_rules, distance_slabs |
| 004 gallery | gallery_assets, gallery_items, gallery_sync_runs |
| 005 conversations | contacts, tags, contact_tags, contact_notes, media, conversations, messages, handover_events, canned_replies |
| 006 sales | leads, quotes, quote_events, bookings, booking_payments, booking_status_history |
| 007 messaging | templates, broadcasts, broadcast_recipients |
| 008 automation | automations, followups |
| 009 ops | webhook_events, ai_runs, ai_tool_calls, audit_log |
| 010 ai | ai_tools (editable tool descriptions, on/off, config); DeepSeek default, UI-saved encrypted key on ai_agent_config |

## Rules the database enforces (not just the app)

| Rule | How |
|---|---|
| A webhook is processed once | `webhook_events UNIQUE (source, event_key)`, inserted with `ON CONFLICT DO NOTHING` before acking |
| A WhatsApp message is stored once | `messages UNIQUE (tenant_id, wa_message_id)` |
| One handover state per chat | `conversations.handling_mode` ∈ bot/human/paused. Non-bot requires `handover_at`. Every switch goes to `handover_events`. |
| **Negotiation floor** | `quotes CHECK (final_price >= floor_price)` and the arithmetic must add up. `bookings CHECK (agreed_price >= floor_price)`. |
| Distance slabs never overlap | `EXCLUDE USING gist (tenant_id WITH =, numrange(min_km,max_km,'[)') WITH &&)` |
| **Only properly named + priced photos are sent** | `gallery_items.is_sendable` is a generated column: name not generic (unless an admin vouches), has a price, not hidden, still in Drive |
| Admin edits survive Drive re-syncs | Sync writes `parsed_*` only. Admins write `override_*`. Effective columns are generated. |
| Advance paid is always correct | A trigger on `booking_payments` keeps `advance_paid_amount`/`advance_status`. Overpaying or reusing a UTR is rejected. |
| Booking status history | A trigger logs every status change. The actor comes from `SET LOCAL bb.actor_type / bb.actor_user_id`. |
| A reminder fires once | `followups UNIQUE (tenant_id, idempotency_key)` |
| Audit log is append-only | A trigger blocks UPDATE/DELETE (except FK SET NULL and tenant cascade) |

## Seed data: everything priced is a placeholder

- All package, pricing-rule and slab amounts are `price_confirmed = false`. Package ranges were **derived from the Drive folder and file names** (website prices are ignored). See the `description` column for each sample size.
- `business_settings.base_lat/lng` is NULL. The distance tool must refuse to run until the client gives the exact pin.
- The global negotiation rule (10%, 2 rounds) and the distance slabs are placeholders.
- Automations are seeded **off**.
- No users are seeded. The owner account is created by a CLI in M2, so no password ever lives in the repo.
