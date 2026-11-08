# Whapter: database analysis (Phase 0)

Source: a read-only, structure-only `pg_dump -s` of database `whapter` from container `whapter-postgres` on the production server. The full DDL is in [whapter-schema-reference.sql](whapter-schema-reference.sql). No row data was exported and no credentials were copied. The dump was scanned for embedded secrets and none were found.

## Engine

- **PostgreSQL 15.4** (image `ankane/pgvector:v0.5.1`), extensions `uuid-ossp` and `vector`.
- Fronted by **PostgREST v12.2** (`whapter-postgrest`, bound to 127.0.0.1:3001). The backend's supabase-js client talks to it. A raw `pg` pool is also used.
- Other databases in the same cluster: `whapter_insta`, `dograh`, `postgres`. None are relevant here.

## Size

137 tables, 191 foreign keys, 268 indexes, 77 RLS policies (RLS enabled on 89 tables), 24 functions, 2 enums (`call_job_status`, `campaign_status`).

## Conventions (we will mirror these)

| Aspect | Whapter convention |
|---|---|
| Primary keys | `id uuid DEFAULT gen_random_uuid() NOT NULL` everywhere |
| Timestamps | `created_at timestamptz DEFAULT now()`, `updated_at timestamptz DEFAULT now()`, kept current by trigger `crm_update_updated_at_column()` (`BEFORE UPDATE ... FOR EACH ROW`) |
| Naming | snake_case, plural table names, feature prefixes (`crm_`, `whatsapp_`, `agent_`), indexes named `idx_<table>_<cols>`, uniques `uq_<table>_<cols>` |
| Enums | Mostly **`text` + `CHECK (col = ANY (ARRAY[...]))`**. Native enums appear only twice. |
| Flexible data | `jsonb DEFAULT '{}'::jsonb` (configs, payloads, vars), `text[]` for tags |
| Money | `numeric(12,2)` (deals), `numeric(12,4)` (credits) |
| Soft deletes | **Rare**. Only `campaigns` and `vobiz_credentials` have `deleted_at`. Elsewhere rows are hard-deleted or use `is_active` / `is_enabled` / `status` flags. |
| Tenant scoping | Tenant = `users.id`. The column is `user_id` (CRM tables) or `tenant_id` (others), FK `→ users(id) ON DELETE CASCADE` (75 FKs). Child rows use `ON DELETE CASCADE` to the parent and `SET NULL` for optional links (contact, assignee). |
| Vector search | `vector(384)` (MiniLM) and `vector(1024)` (Cohere) columns, `match_*` RPC functions |
| Phone numbers | `text`, normalised by `pg_normalize_phone(phone, '91')`, unique per tenant `(user_id, phone)` |

## Multi-tenancy model

- `users` is both the login and the tenant root. Team members are other `users` rows linked through `workspace_members (tenant_id, member_user_id, role_id)`. `workspace_roles.permissions` is a jsonb map of permission keys.
- Legacy `tenants` / `tenant_users` / `organizations` tables also exist (from older specs) but are mostly unused by the WhatsApp product.
- RLS policies use `auth.uid()` / `auth.tenant_id()` (functions that read PostgREST JWT claims). The backend mainly uses the service role, so **real isolation is application-level filtering**.

## Core WhatsApp/CRM tables and relationships

```
users (tenant)
 ├─ whatsapp_accounts (user_id, phone_number_id UNIQUE per user, access_token enc, ai_chatbot_enabled,
 │                     crm_flow_id, chatbot_config jsonb, plugins_enabled jsonb)
 ├─ tenant_ai_settings (tenant_id, system_prompt, active_model, human_takeover_keywords jsonb,
 │                      max_history_messages, history_strategy, rag_*, response_delay_*)
 ├─ crm_contacts (user_id, phone, name, source, assigned_to → users, UNIQUE(user_id, phone))
 │    ├─ crm_contact_tags → crm_tags
 │    ├─ crm_contact_custom_values → crm_custom_fields
 │    ├─ crm_contact_notes
 │    └─ crm_conversations (user_id, contact_id, status, flow_owner 'bot'|'human',
 │         │                 flow_cooldown_until, assigned_agent_id, unread_count, last_message_*)
 │         ├─ crm_messages (conversation_id, sender_type customer|agent|bot, content_type CHECK,
 │         │                 status sending|sent|delivered|read|failed, message_id UNIQUE when not null)
 │         └─ crm_deals → crm_pipelines / crm_pipeline_stages (value numeric(12,2), status open|won|lost)
 ├─ whatsapp_messages (tenant_id, from/to, direction CHECK, content jsonb, wa_message_id, campaign_id)
 │      → triggers sync_whatsapp_message_to_crm / sync_whatsapp_status_to_crm copy into crm_messages
 ├─ chat_conversations (tenant_id, contact_id TEXT phone, status bot_active|human_escalated|resolved,
 │      conversation_summary)  ← AI memory side
 │    └─ chat_messages
 ├─ agent_tools (+ tool_configuration, tool_execution_logs, agent_tool_assets)
 ├─ agent_action_assets (media library: title, tags text[], mime_type, asset_url, embedding)
 ├─ knowledge_documents → knowledge_chunks (vector)
 ├─ whatsapp_templates / crm_message_templates
 ├─ campaigns (deleted_at) → campaign_recipients (UNIQUE(campaign_id, phone_number))
 ├─ crm_broadcasts → crm_broadcast_recipients
 ├─ crm_flows → crm_flow_nodes, crm_flow_runs (vars jsonb, status CHECK) → crm_flow_run_events
 ├─ crm_automations → crm_automation_nodes, crm_automation_logs
 ├─ scheduled_followups (tenant_id, contact_phone, messages jsonb, scheduled_at, status, bullmq_job_id, cancel_on_reply)
 ├─ webhook_events (tenant_id, event_type, payload jsonb, status)  ← log only, no idempotency key
 ├─ ai_usage_logs, admin_audit_logs
 └─ workspace_roles / workspace_members / workspace_invitations
```

## Weak spots (we will fix these in the new schema rather than copy them)

1. **Duplicate conversation and message stores.** `chat_conversations`/`chat_messages`, `crm_conversations`/`crm_messages` and `whatsapp_messages` are kept in sync by triggers and app code, and handover state lives in two of them. The new schema has **one** `conversations` table and **one** `messages` table.
2. **No DB-level idempotency** for inbound messages (`whatsapp_messages.wa_message_id` is not unique) or for webhook events. The new schema adds `UNIQUE (tenant_id, wa_message_id)` and `webhook_events.event_key UNIQUE`.
3. `chat_conversations.contact_id` is a phone **text**, not an FK. The new schema uses proper FKs.
4. Missing indexes on some hot paths, for example `whatsapp_messages (tenant_id, created_at)`. The new schema indexes all FKs, phone, conversation status and `created_at`.
5. `crm_deals.currency DEFAULT 'USD'`. The new default is `INR`.
6. Few CHECKs on money and percentages. The new schema adds `CHECK (>= 0)` and caps discount percentages at 0..100.

## Proposed approach for BalloonsBuzz (Phase 2 preview, for approval)

- Same engine: **PostgreSQL 15 + pgvector** (pgvector only if we keep embeddings for gallery and FAQ search).
- Same conventions: uuid PKs, `created_at`/`updated_at` + trigger, text + CHECK enums, jsonb configs, `tenant_id → tenants/users ON DELETE CASCADE`, `idx_`/`uq_` naming.
- Soft deletes: `deleted_at` only where history matters (contacts, packages, themes, gallery images, bookings), matching Whapter's sparse use. Everything else hard-deletes or uses `is_active`.
- Migrations: numbered SQL files (`db/migrations/001_*.sql`) like Whapter, plus a runner script that records applied files in a `schema_migrations` table, which Whapter lacks.
