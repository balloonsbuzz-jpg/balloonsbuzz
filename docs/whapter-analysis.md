# Whapter: codebase analysis (Phase 0)

Source: `D:\whapter`, read-only. Written 2026-11-08 as input for the BalloonsBuzz WhatsApp Platform.

## 1. Big picture

Whapter is a multi-product SaaS with three "rooms": **WhatsApp**, **Voice** (Vobiz/Omnidim/LiveKit/Dograh) and **Instagram**. It also has an agency/white-label layer, a blog/SEO site, food ordering with delivery (Uber Direct and in-house drivers), and billing (PhonePe, wallet credits).

| Layer | Tech |
|---|---|
| Frontend | React 19 + Vite, Tailwind v4, react-router 7, TanStack Query, @xyflow/react (flow builder), shadcn-style UI kit in `components/crm/components/ui`, recharts/chart.js. Hosted on Vercel. |
| Backend | Node.js + Express 4 (`backend/server.js`), CommonJS, Jest tests. Run by **PM2** (`ecosystem.config.js`), deployed by a GitHub Action that SSHes in, runs `git reset --hard`, then `pm2 reload`. |
| DB access | `@supabase/supabase-js` pointed at a **self-hosted PostgREST** (not Supabase cloud), plus a raw `pg` pool in `backend/db.js`. |
| Queues | BullMQ on Redis (`ioredis`) |
| Storage | MinIO (S3 API via `@aws-sdk/client-s3`), Cloudinary in some places |
| Realtime | Server-Sent Events (`sse.service.js`, `sseEventBus.service.js`) |
| AI | Provider router for OpenAI, Gemini, Groq, Anthropic, OpenRouter and custom providers. Local MiniLM embeddings (`@xenova/transformers`) and Cohere embeddings, stored in pgvector. |

Server containers (from `docker ps`): `whapter-postgres` (pgvector, PG 15.4), `whapter-postgrest` (v12.2), `whapter-redis`, `whapter-minio`. The Node API itself runs under PM2 on the host, not in Docker.

## 2. Backend folder map

```
backend/
  server.js               Express wiring, CSRF, helmet, rate limits, raw-body capture, workers start/stop
  routes/*.routes.js      ~40 routers (whatsapp, webhook, crm, ai-settings, action, campaign, human-inbox, ...)
  controllers/*.js        Business logic per route
  services/               Meta send, queues and workers, flows engine, automations engine, journeys, storage, SSE
  services/ai/            prompt, memory, summary, RAG, escalation, provider-manager, reply-sanitizer, prompt-injection
  ai/runtime/             agent-runtime.js (tool loop), whatsapp-renderer.js (renders AI output to WA messages)
  ai/tools/               registry.js + builtins/ (knowledge_search, calculator, http_request, send_media,
                          media_search, schedule_followup, place_food_order, create_calendar_event) + custom/
  plugins/                live_chat, broadcast, chatbot, transactional (per-number feature switches)
  middleware/             auth (JWT cookie), permission (workspace RBAC), csrf, webhookSignature, rate limiters
  migrations/             ~150 hand-written SQL files, applied ad hoc by scripts/run-migration-*.js
```

## 3. WhatsApp integration

- **API:** Meta WhatsApp **Cloud API** (Graph `v20.0`, configurable through `META_API_VERSION`). There is no BSP and no on-premise API. It supports Embedded Signup and manual token entry, plus "coexistence" (the business app and the API on the same number).
- **Webhook:** `POST /api/webhook/:tenantId` (and a legacy `/api/webhook/whatsapp`).
  - `webhookSignature.middleware.js` checks HMAC-SHA256 `X-Hub-Signature-256` against the raw body with `timingSafeEqual`. It **fails closed** if no secret is configured.
  - `handleWebhook` returns **200 immediately**, then processes in the same process (not queued). Routing uses `metadata.phone_number_id` → `whatsapp_accounts.user_id`.
  - Idempotency: a Redis `SET NX processed_msg:{tenant}:{wamid}` with 300s TTL, then a DB check on `whatsapp_messages.wa_message_id`. There is **no unique constraint** on `wa_message_id`.
  - A per-contact Redis spin lock (`flow_contact_lock:{tenant}:{phone}`) serialises messages from the same customer.
  - It handles text, image/video/audio/document (it reclassifies documents by MIME type), location, interactive (button, list, location_reply, address, nfm_reply/WhatsApp Forms), reactions, order (catalog), statuses, template status updates, history sync and message echoes (it detects a human typing on the phone app and starts a cooldown).
- **Inbound dispatch order** (`processInboundMessages`):
  1. **CRM Flows engine** (`crm-flows-engine.dispatchInboundToFlows`). If a flow consumes the message, processing stops.
  2. If a **human-message cooldown** is active, everything is skipped.
  3. **Tag-to-Agent**: a contact tag selects a specific AI agent flow.
  4. Otherwise the global **chatbot plugin**: keyword replies first, then `aiQueue.addAiJob`.
  5. **CRM Automations** `keyword_match` and `first_inbound_message` triggers.
- **Send:** `meta-whatsapp.service.js` `graphRequest` retries with backoff, honours `retry-after` and masks secrets in logs. It covers text, media by link, template, interactive (raw payload), location, contacts, reaction, read receipts and media upload (it enforces the 5 MB image and 16 MB video limits). `crm-meta-send.js` wraps sends with **takeover and cooldown guards**, an AI reply cap and outbound validation.
- **Media:** Inbound media is downloaded from Graph and stored in MinIO. Outbound media is sent by public URL (`link`).

## 4. AI agent

There are two runtimes:

1. **Standard AI** (`ai/runtime/agent-runtime.js`), invoked from the BullMQ `aiWorker`.
   - Config: `tenant_ai_settings` holds `system_prompt`, `active_model`, `human_takeover_keywords`, `max_history_messages`, `history_strategy` (last_n or last_n + summary), RAG settings, `response_delay_*` and `compiled_agent_config`. Platform-level models and API keys are in `platform_whatsapp_ai_config`.
   - Memory: `chat_messages` history (last N) plus a rolling `chat_conversations.conversation_summary`.
   - RAG: `knowledge_documents` / `knowledge_chunks` (pgvector) via `match_knowledge_chunks*` RPCs.
   - Tools: built-ins plus tenant **custom actions** (`agent_tools` + `tool_configuration`). Tools are discovered by embedding similarity (top N). Action types: `static`, `database`, `media_library`, `http`/webhook. Every call is logged to `tool_execution_logs`.
   - Media library: `agent_action_assets` with `tags text[]`, embeddings and a `match_action_assets` RPC. `agent_tool_assets` links assets to a tool. Photos already sent are rotated out using message history.
   - Safety: prompt-injection filter, reply sanitizer (strips leaked internal notes), escalation service (keyword → human).
   - Worker guards: it re-checks takeover state **before the LLM call and again after the response delay**, and holds a Redis lock so only one generation runs per conversation.
2. **Flow AI Agent node** (`services/crm-flows-ai-agent.js`): an `ai_agent` node inside a visual flow, with connected `ai_tool` / `ai_model` / `ai_memory` nodes. Predefined tools include `human_handoff`, `add_tag`/`remove_tag`, CRM contact CRUD, `send_message`, `assign_agent` and `close_conversation`. It is multi-provider and logs cost per call (`ai_usage_logs`).

## 5. Flows, automations and journeys

- **CRM Flows** (`crm_flows`, `crm_flow_nodes`, `crm_flow_runs`, `crm_flow_run_events`): the visual builder. Node types: `start, send_message, send_buttons, send_list, send_media, send_template, collect_input, condition, if_elseif_else, wait, set_tag/add_tag/remove_tag, handoff, notify, end, request_location, request_address, calculate_distance` (haversine from one store or several), `whatsapp_form, ai_agent, ai_tool, ai_model, ai_memory, sales_crm, create_order, confirm_order, reject_order, format_order_summary, clear_cart, track_order_status, uber_direct_delivery`. Triggers: keyword, first or any inbound message, manual, campaign status, human handoff, webhook lead, widget. There is a fallback policy (reprompt, then handoff), a per-flow cooldown and a trigger-once option.
- **CRM Automations** (`crm_automations`, `crm_automation_nodes`, `crm_automation_logs`): simpler event → action chains (first inbound, keyword, campaign concluded).
- **Journey engine** (`journey_instances`): multi-step drip playbooks.
- **Trigger registry / public triggers:** inbound API (`/api/v1/public`, `/api/trigger`) for external systems.

## 6. Human handover

The same state is tracked in **two places**, kept in sync by application code:

- `chat_conversations.status` ∈ `bot_active | human_escalated | resolved` (AI runtime side)
- `crm_conversations.flow_owner` ∈ `bot | human` plus `status` (open, pending, needs_human, ...) plus `flow_cooldown_until` (CRM/inbox side)

Takeover (`POST /human-inbox/conversations/:id/takeover`, or `/crm/conversations/by-phone/:phone/flow-takeover`) sets human ownership and starts a cooldown. Resolve/resume clears both. An agent replying from the inbox, or from the phone app (detected via message echo), also starts a cooldown. Handover events go to the UI over SSE (`agent_takeover`, `flow_owner_update`).

## 7. Broadcasts, templates and follow-ups

- **Templates:** `whatsapp_templates` / `crm_message_templates`, synced with Meta, plus a template builder UI.
- **Campaigns/broadcasts:** `campaigns` + `campaign_recipients` (and `crm_broadcasts`). Built on BullMQ `campaignQueue`/`campaignWorker` with batch size, send delay, pause/stop/retry, scheduled sends (`campaignScheduler` cron), and status propagation from webhooks into recipients.
- **Follow-ups:** `scheduled_followups` + `followupQueue`/`followupWorker` (BullMQ delayed jobs). The AI's `schedule_followup` tool creates them. `cancel_on_reply` cancels pending follow-ups when the customer replies.
- `crm-pending-executions` scheduler handles `wait` nodes. `dataRetention` cron prunes old data.

## 8. CRM, commerce and analytics

- Contacts (`crm_contacts`, unique `(user_id, phone)`), tags, custom fields, notes, CSV import, canned messages.
- Pipelines/deals (Kanban): `crm_pipelines`, `crm_pipeline_stages`, `crm_deals`. There is also a separate `sales_crm_leads` table.
- Commerce: `restaurants`, `menus`, `menu_items`, `orders`, `order_events`, `food_store_settings`, delivery (Uber Direct, in-house staff). This is food-specific.
- Analytics: CRM dashboard (conversations, response time, pipeline), AI analytics (usage and cost), campaign stats, commerce analytics.

## 9. Auth, roles and multi-tenancy

- Auth: email + password (bcrypt) with OTP verification, Google OAuth, JWT in HTTP-only cookies, CSRF double-submit, helmet, rate limits.
- **Tenant = the `users.id` of the account owner.** Tables scope by `user_id` (CRM tables) or `tenant_id` (everything else). Both columns reference `users(id) ON DELETE CASCADE`.
- Team: `workspace_members` (tenant_id, member_user_id, role_id) + `workspace_roles` (permissions jsonb, for example `whatsapp:inbox`). Enforced by `permission.middleware.js` and `<PermissionRoute>` on the frontend. Invitations exist, and an agency layer (`users.role`, `agency_id`) sits on top.
- RLS policies exist (`auth.uid()` / `auth.tenant_id()` read from PostgREST JWT claims), but most backend code uses the service role, which bypasses RLS. Tenant isolation therefore relies on `.eq('user_id', ...)` in application code.

## 10. Observations to carry into BalloonsBuzz

**Reuse (patterns and code):** signature middleware; the fast-ack plus Redis-dedup webhook pattern; `graphRequest` retry and backoff; the takeover guard checked before and after the LLM call; the per-conversation AI lock; the media-library tool with rotation of already-sent assets; the follow-up queue with cancel-on-reply; the haversine distance code; SSE inbox events; the BullMQ worker structure.

**Do not copy:**
- **Hardcoded DB connection string fallback in `backend/db.js`.** It contains a real credential and should be rotated in Whapter. It will not be copied here.
- Two parallel conversation and message models (`chat_*` vs `crm_*` vs `whatsapp_messages`) synced by triggers and app code. BalloonsBuzz will use **one** `conversations` table and **one** `messages` table.
- Webhook processing runs in-process after the ack. BalloonsBuzz will **enqueue** the raw event and let a worker process it, as the brief requires.
- No unique constraint on `wa_message_id`. BalloonsBuzz will enforce idempotency in the DB.
- The PostgREST indirection. For a single client, plain `pg` (Whapter already has `db.js`) is simpler. *To confirm with you.*
- Voice, Instagram, food/Uber, agency/white-label, blog/SEO, PhonePe wallet credits, multi-provider BYOK and the landing pages.

## 11. Feature-parity matrix (Whapter → BalloonsBuzz)

| Whapter feature | Decision | Notes for BalloonsBuzz |
|---|---|---|
| WhatsApp Cloud API connect (manual token) | **Keep** | One number (+91 93925 34625). Embedded Signup → **drop**; manual config is enough. |
| Webhook (signature, ack, dedup) | **Adapt** | Ack, then write `webhook_events` (unique on event key), then queue, then worker. |
| Send service with retries | **Keep** | Text, media, template, interactive buttons/list, location request. |
| Shared inbox (SSE realtime) | **Keep** | Plus prominent handover controls (pause bot, take over, resume bot). |
| Human handover / cooldown | **Adapt** | One state machine on `conversations` plus a `handover_events` history. Required by the quote. |
| Standard AI agent + tool loop | **Adapt** | Fixed BalloonsBuzz tool set. Prompt in `ai_agent_config`. One provider, configurable. |
| Custom actions builder (agent_tools UI) | **Drop** | Tools are fixed in code. Their settings are edited in pricing, gallery and distance screens. |
| Media library + `send_media` | **Adapt** | Becomes the **Gallery**: images tagged by theme, occasion and package plus a price band. Tag lookup first, embeddings optional. |
| Knowledge base / RAG | **Adapt (light)** | FAQ entries (policies, inclusions). pgvector optional; plain text injection is enough at this size. |
| Prompt-injection filter + reply sanitizer | **Keep** | |
| Response delay, "typing" feel | **Keep** | Supports the "short and sweet" multi-message style. |
| Visual Flow builder (xyflow, 30+ node types) | **Drop for v1** | The AI agent plus tools covers the sales flow. Revisit if the client wants scripted menus. |
| CRM Automations (event → action) | **Adapt (light)** | Keep a few fixed automations: welcome on first message, post-booking reminders, review request after the event. |
| Journeys / drip playbooks | **Merge into follow-ups** | |
| Scheduled follow-ups (cancel on reply) | **Keep** | Lead nurture: quote sent but not booked, advance pending, event reminders. |
| Templates (Meta sync, builder) | **Keep** | Needed for messages outside the 24h window and for broadcasts. |
| Broadcast campaigns (queue, pause, retry, schedule) | **Keep** | Festive offers, past-customer re-engagement. |
| Contacts, tags, custom fields, notes, import | **Keep** | |
| Pipelines/deals Kanban | **Adapt** | Becomes the **Bookings board** (Enquiry → Quoted → Advance pending → Confirmed → Done/Cancelled). |
| Sales CRM leads | **Adapt** | Becomes `leads` (qualification fields: occasion, theme, date, venue, guests, budget). |
| Food commerce (menus, orders, cart, Uber) | **Drop** | Replaced by packages, themes, pricing rules and bookings. |
| `calculate_distance` node | **Adapt** | Becomes the `calculate_distance_charge` tool: haversine from the Miyapur base, then configurable distance slabs. Google geocoding for typed addresses (*to confirm: API key*). |
| `request_location` node | **Keep (as tool)** | Interactive location request message. |
| Payments (PhonePe wallet) | **Adapt** | Advance collection. v1: UPI link or QR plus a manual "advance received" mark. Payment gateway *to confirm with client*. |
| Google Calendar event tool | **Optional** | Block event dates. *To confirm.* |
| Workspace members + RBAC | **Adapt** | Single tenant. Roles: owner, admin, agent. |
| Multi-tenancy (`user_id`/`tenant_id` everywhere) | **Adapt** | Keep a `tenant_id` column for future reuse, seeded with one BalloonsBuzz tenant. *To confirm.* |
| Agency / white-label / admin portal | **Drop** | |
| AI analytics (usage/cost) | **Keep** | Plus sales analytics: leads, conversion, bookings, revenue, handovers. |
| Read receipts settings | **Keep** | |
| WhatsApp Forms (Meta Flows) | **Drop for v1** | |
| Instagram, Voice, Telecaller, Omnidim, Vobiz, LiveKit, Dograh | **Drop** | |
| Blog/SEO/landing pages, billing plans, wallet | **Drop** | |
| Audit logs (`admin_audit_logs`) | **Adapt** | Becomes a general `audit_log` (price/rule edits, handovers, discounts granted). |

**New for BalloonsBuzz (not in Whapter):** negotiation rules enforced in code; distance slabs; packages, themes and pricing rules; gallery tags by theme, occasion and package; bookings with event date, venue, quoted price and advance.
