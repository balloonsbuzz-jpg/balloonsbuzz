# BalloonsBuzz WhatsApp Platform: Plan (Phase 1)

Status: draft for approval · 2026-11-08 · Inputs: [whapter-analysis.md](whapter-analysis.md), [whapter-db-analysis.md](whapter-db-analysis.md), [balloonsbuzz-business.md](balloonsbuzz-business.md)

## 0. Decisions locked in Phase 0

| Topic | Decision |
|---|---|
| Stack | React (Vite) + Node.js/Express + **PostgreSQL 15 (+pgvector)**, the same engine and conventions as Whapter |
| DB access | Plain `pg` pool with parameterised SQL in small repository modules. No PostgREST, no ORM. |
| Tenancy | `tenant_id uuid` on every business table → `tenants(id)`. One tenant (BalloonsBuzz) is seeded. Every query is tenant-scoped in the repository layer. |
| Distance | A provider interface. **Default: haversine × configurable road factor** (no key needed; the customer sends a location pin). **If `GOOGLE_MAPS_API_KEY` is set:** geocode typed addresses and use Distance Matrix driving distance. |
| Flow builder | Out of v1. The AI agent plus a fixed set of tools covers the sales journey. |
| Deployment | Full **Docker Compose**: postgres, redis, minio, api, worker, web |
| Queue | BullMQ on Redis, like Whapter |
| WhatsApp | Meta Cloud API (Graph v20+), one number: +91 93925 34625 |

## 1. Architecture

```
                    Meta WhatsApp Cloud API
                     │ webhook            ▲ Graph API (send / media / templates)
                     ▼                    │
┌──────────── api (Express) ──────────────┴───────────┐
│ POST /webhook/whatsapp                               │
│   1. verify X-Hub-Signature-256 (raw body)           │
│   2. INSERT webhook_events (event_key UNIQUE)        │──► ON CONFLICT → 200, done (idempotent)
│   3. enqueue inbound:{id}  4. 200 OK  (target <50ms) │
│ REST /api/* (JWT cookie + RBAC) · SSE /api/stream    │
└───────────────┬──────────────────────────────────────┘
                │ BullMQ (Redis)
┌───────────────▼────────────── worker ────────────────────────────────┐
│ inbound    → parse → upsert contact/conversation/message (UNIQUE wamid)│
│              → handover gate → enqueue ai-reply (debounced per convo)  │
│ ai-reply   → Agent service: prompt + history + tools loop              │
│              tools: get_pricing · send_photos · calculate_distance_charge│
│                     check_negotiation_limit · create_booking            │
│                     handover_to_human · request_location · update_lead  │
│                     schedule_followup                                   │
│              → outbound guard (price check, takeover recheck) → send   │
│ send       → Graph API with retry/backoff, status tracking             │
│ statuses   → delivered/read/failed → messages, broadcast recipients    │
│ followups  → delayed jobs, cancel-on-reply                             │
│ broadcasts → batched template sends, pause/resume, rate-limited        │
│ cron       → reminders (event −1 day), review ask (+1 day), cleanup    │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
   PostgreSQL 15 + pgvector      MinIO (gallery images, inbound media)
                ▲
┌───────────────┴──── web (React, served by nginx, proxies /api) ───┐
│ Dashboard · Inbox+handover · Contacts/Leads · Bookings board ·     │
│ Gallery · Pricing/Negotiation/Distance settings · Agent prompt ·   │
│ Templates/Broadcasts · Follow-ups · Analytics · Users/Roles · Audit │
└────────────────────────────────────────────────────────────────────┘
```

The **api** and **worker** share one codebase with two entry points (`src/server.js`, `src/worker.js`) and scale independently.

### Repo layout

```
backend/
  src/server.js  src/worker.js
  src/config/            env validation (fail fast on missing vars)
  src/db/                pool, tx helper, repositories/*.js (tenant-scoped)
  src/routes/ src/controllers/ src/middleware/   (auth, rbac, signature, rate limit, errors)
  src/whatsapp/          graph client, send service, webhook parser, templates
  src/agent/             runtime (tool loop), prompt builder, provider adapter, tools/*.js, outbound-guard
  src/pricing/           quote engine, negotiation, distance (haversine + google provider), slabs
  src/queues/            queue defs + processors
  src/realtime/          SSE bus (Redis pub/sub so api and worker can both emit)
  tests/                 Jest + supertest, against a disposable Postgres
db/
  migrations/NNN_*.sql   schema.sql (generated snapshot)  seeds/*.sql  migrate.js
frontend/                React + Vite + Tailwind, Whapter's UI kit patterns
prompts/balloonsbuzz-agent.md
docker-compose.yml  docker-compose.override.yml (dev)  .env.example
```

## 2. The four mandatory customisations: how each is enforced

### 2.1 Send photos for the customer's design and budget
Full rules: [gallery-catalog.md](gallery-catalog.md).
- **Source:** the client's Google Drive folder (910 photos). **Design category, theme and price are encoded in the folder and file names**, for example `2 frames decor/dinosour/Dinosaur Theme (10k-12k).jpeg`.
- **Import and sync:** the first load comes from the zip. After that a Drive API sync job runs (cron plus a "Sync now" button). Each file is normalised to JPEG under 1 MB, stored in MinIO, and parsed into category, theme (typo-normalised), style, occasion and `price_min`/`price_max`. **Only photos with a proper descriptive name and a price (file name, else folder) are ever sent.** Hash, UUID, `WhatsApp Image …` and web-download names are excluded. Website prices are ignored. That leaves ~379 sendable photos at the first import. Duplicates are found by content hash, and an image filed under several categories keeps every placement.
- Tables: `gallery_assets` (one per unique file: sha256, storage key, URL, dimensions, Drive file id), `gallery_items` (one per Drive path placement: category, theme, style, occasion, price range, price source, `is_active`), `override_*` columns on `gallery_items` (manual UI edits that the sync never touches; the effective values and `is_sendable` are generated columns), `themes` + `theme_aliases`, `gallery_sync_runs` (report).
- Tool `send_photos({occasion?, theme?, budget_min?, budget_max?, style?, count≤5})`:
  1. Score images: theme/alias match, occasion match, **budget overlap**, style.
  2. Exclude photos already sent in this conversation.
  3. Spread the picks across categories within the budget.
  4. Send as WhatsApp images with the caption "Design title · ₹X–Y (estimate)".
- When the customer gives a budget but no design, the agent suggests the best designs within that budget. When they pick a photo (by replying to it), the agent quotes that design's category through the quote engine.
- If nothing matches, the tool returns `no_match` with the nearest cheaper option. It never sends random photos.
- Optional: pgvector embeddings on titles and aliases for fuzzy phrases ("pink unicorn"). Off by default.

### 2.2 Human handover
- One state on `conversations.handling_mode` ∈ `bot | human | paused`, with `assigned_user_id`, `handover_reason`, `handover_at`, and `bot_resume_at` (optional auto-resume). Every change is written to `handover_events` (who, why, from→to).
- Triggers to human: the customer asks (keyword plus model intent), a discount is over the limit, the agent is stuck (N failed tool calls or repeated confusion), the order is out of scope (distance beyond max, date conflict), or an agent clicks **Take over**.
- The worker **checks `handling_mode` before the LLM call and again right before sending**, and drops the bot reply if a human has taken over. This is Whapter's pattern.
- Inbox: Take over / Pause bot / **Resume bot** buttons, a "Needs human" queue with an unread badge, and a staff alert (an SSE toast, plus an optional WhatsApp template to a staff number).
- On resume, the bot gets a system note summarising what the human said, so it doesn't repeat questions.

### 2.3 Negotiation limit, enforced in code
- `negotiation_rules`: scope (`global` | `package` | `theme`), `max_discount_pct`, `max_discount_amount`, `min_final_price`, `applies_to_addons`, `applies_to_distance_charge`, `max_rounds`.
- The **quote engine** (pure function, unit-tested) computes `list_price`, `distance_charge`, `addons`, and **`floor_price` = the most restrictive of all applicable rules**.
- Tool `check_negotiation_limit({quote_id, requested_price})` returns `allowed`, `counter_offer_price` (a stepped concession, never below the floor) or `escalate`. When it returns `escalate`, the runtime calls `handover_to_human` itself; this doesn't depend on the model.
- `create_booking` **rejects** any `agreed_price < floor_price` (DB `CHECK` plus a service check).
- **Outbound guard:** every rupee amount in an AI message must match an amount issued by a pricing tool in this conversation (`quotes` / `quote_events`). Unknown or below-floor amounts block the message and trigger a handover. This is what turns "never invent prices" from a prompt instruction into a code guarantee.
- Every concession is logged in `quote_events` and `audit_log`.

### 2.4 Location distance charge
- Tool `request_location()` sends WhatsApp's interactive *location request* message.
- Tool `calculate_distance_charge({lat,lng} | {address})`:
  - With a pin: haversine from `business_settings.base_lat/lng` × `road_factor` (default 1.3), or Google driving distance if a key is set.
  - With a typed address: Google geocode if a key is set. Otherwise it asks for a pin.
  - Slab lookup in `distance_slabs (min_km, max_km, charge_type flat|per_km, amount)`. Beyond `max_service_km`, it returns `out_of_area` and hands over to a human.
- The result is stored on the lead/quote (`venue_lat`, `venue_lng`, `distance_km`, `distance_charge`, `distance_method`).

## 3. Feature list (parity with Whapter)

| # | Feature | Whapter source pattern | v1 |
|---|---|---|---|
| F1 | Auth (email + password, JWT httpOnly cookie, CSRF, rate limit), users, roles owner/admin/agent | auth.controller, permission.middleware | ✅ |
| F2 | WhatsApp connection settings (token, phone_number_id, WABA, verify token) with a health check | whatsapp-accounts | ✅ |
| F3 | Webhook: signature check, idempotent, fast ack, queue | webhook.controller (improved) | ✅ |
| F4 | Send service: text, image, document, template, buttons, list, location request; retries | meta-whatsapp.service | ✅ |
| F5 | Shared inbox: realtime SSE, filters (bot / human / needs-human / unread), quick replies, media, notes | crm Inbox, human-inbox | ✅ |
| F6 | Handover controls and history | crm-meta-send guards, human-inbox | ✅ |
| F7 | **AI Agent screen** (Whapter's AI Settings): **editable system prompt** with version history, diff and one-click rollback; provider/model (**DeepSeek default**: `deepseek-chat`, fallback `deepseek-reasoner`); API key from `DEEPSEEK_API_KEY` or saved in the UI (encrypted; shown as ••••last4); temperature, history window, summary interval, max message length, messages per turn, response delay, handover keywords, handover and out-of-hours messages, bot on/off switch; **test console** (chat with the bot from the dashboard, with tool calls shown) | tenant_ai_settings, platform_whatsapp_ai_config, agent-runtime | ✅ |
| F8 | **Tools screen** (Whapter's agent_tools overrides): the 9 tools with on/off, **editable description** (what the model reads) plus reset to default, and per-tool settings (for example photos per reply). Pricing, negotiation and handover are locked on. A tool-call log per conversation. Also FAQ knowledge snippets. | tool registry, agent_tools | ✅ |
| F8b | DeepSeek specifics carried over from Whapter: the reply sanitizer (strips leaked reasoning and tool calls written as text, "DSML" markup), automatic prompt caching (static prompt first), and cost tracking per run in ₹ | reply-sanitizer.js, aiUsage.js | ✅ |
| F9 | Catalog: occasions, themes, packages, add-ons, pricing rules | (new; replaces food menus) | ✅ |
| F10 | Gallery: Google Drive sync + zip import, auto-parse of category/theme/price from names, import report, overrides, preview, enable/disable | MediaLibrary | ✅ |
| F11 | Negotiation and distance settings | (new) | ✅ |
| F12 | Contacts and leads (qualification fields, tags, notes, CSV import/export) | crm_contacts, sales_crm_leads | ✅ |
| F13 | Bookings board (Kanban): Enquiry → Quoted → Advance pending → Confirmed → Completed / Cancelled; advance tracking | Pipelines | ✅ |
| F14 | Templates: Meta sync, create, status | template.controller | ✅ |
| F15 | Broadcasts: audience by tag/segment, schedule, pause/resume, per-recipient status | campaign queue/worker | ✅ |
| F16 | Follow-ups and fixed automations: no reply after quote, advance pending, event reminder, post-event review | followup queue, automations | ✅ |
| F17 | Analytics: leads, conversion funnel, bookings and revenue, response time, handover rate, AI cost | crm-dashboard, ai-analytics | ✅ |
| F18 | Audit log | admin_audit_logs | ✅ |
| F19 | Advance payment link (UPI deep link/QR in v1; Razorpay later) | phonepe service | ✅ (UPI) |
| F20 | Google Calendar sync for bookings | google-calendar | ⏳ optional |
| — | Flow builder, WhatsApp Forms, Instagram, Voice, food/Uber, agency, billing | | ❌ |

## 4. Milestones (build order, with acceptance criteria)

Each milestone ends with green tests, a short summary to you, and your go-ahead.

**M0: Scaffold and infrastructure**
- Monorepo, Docker Compose (dev + prod), env validation, logger, health endpoints, ESLint, Jest, Vitest.
- ✅ `docker compose up` brings all six services up healthy. `GET /health` reports the DB, Redis and MinIO as OK. CI runs lint and tests.

**M1: Database (Phase 2)**
- Migrations + runner (`schema_migrations`), `db/schema.sql` snapshot, seeds (tenant, owner user, occasions, themes, packages with TODO prices, a default slab set, a default negotiation rule).
- ✅ `npm run migrate` on an empty DB succeeds and is re-runnable. A rollback-tested down file exists for each migration. A seed check asserts row counts. Every FK, phone, status and created_at column has an index (verified by a test query on `pg_indexes`).

**M2: Auth, RBAC, audit**
- ✅ Login/logout/refresh. An agent can't reach settings (403 test). Every settings mutation writes `audit_log`. No secrets appear in logs (test).

**M3: WhatsApp in/out**
- Webhook, inbound processor, send service, status updates, media download to MinIO.
- ✅ A bad signature gets 403. The same payload ×3 produces one message row. Ack p95 < 100 ms locally. A text sent from the UI arrives and its status moves sent → delivered → read. A 429 or 5xx from Graph is retried with backoff (mocked test).

**M4: Inbox and handover**
- ✅ A new inbound message appears in the UI in under 2 s via SSE. Take over makes the bot silent (test: an AI job queued before takeover is dropped at the send recheck). Resume brings the bot back. Every switch appears in `handover_events`.

**M5: Catalog, pricing, negotiation, distance, gallery**
- ✅ Quote engine unit tests cover slab edges (5.0 km, 5.01 km), discount caps (% vs ₹ — the most restrictive wins), out-of-area, and add-ons both inside and outside the discount rule. The **zip import** loads all 821 unique photos, and the import report lists the unpriced and excluded ones. File-name price parsing passes a fixture of every real naming variant (`8k`, `(5-7k)`, `(6.5k-8.5)`, `14k-15k`, `Peppa Pig(18k-20k`). **Drive sync** is idempotent (a second run changes 0 rows), picks up a renamed file's new price, and leaves manual overrides intact. A "Dinosaur, 2 frames, ₹10–12k" query returns dinosaur 2-frame photos within the budget.

**M6: AI agent**
- Provider adapter, prompt builder, tool loop, outbound guard, response delay, the `prompts/balloonsbuzz-agent.md` prompt (Phase 4), and a test console in the UI.
- ✅ Scripted conversations (mocked LLM plus a recorded real-model eval set):
  - (a) Qualifies all six fields.
  - (b) Sends matching photos and never repeats them.
  - (c) A below-floor request leads to a counter offer, then a handover.
  - (d) An invented price is blocked by the guard.
  - (e) A location pin gets the correct slab charge.
  - (f) "talk to a person" hands over.
  - (g) Each bot message is ≤ 300 characters, and long content is split.

**M7: Leads and bookings**
- ✅ `create_booking` from chat creates a booking in "Advance pending" with the agreed price ≥ floor (DB CHECK test). Moving a card on the board updates status and audit. Marking the advance as received sends the confirmation template. A double-booked date warns about the capacity limit.

**M8: Templates, broadcasts, follow-ups**
- ✅ Template sync from Meta. A broadcast to a tag segment can be scheduled and paused, retries failures, and respects opt-outs. A follow-up is cancelled when the customer replies. The event-reminder cron fires once per booking (idempotent).

**M9: Dashboard and analytics**
- ✅ KPIs match SQL fixtures. Date-range filter. CSV export.

**M10: Hardening and deploy**
- Rate limits, backups (nightly `pg_dump`, plus MinIO bucket mirroring), log rotation, an uptime check, a security pass, and a UAT script with the client.
- ✅ A restore drill from backup succeeds. UAT checklist signed off.

## 5. Environment variables (names only)

```
# app
NODE_ENV  PORT  APP_URL  FRONTEND_URL  LOG_LEVEL  TRUST_PROXY  DEFAULT_TENANT_SLUG
# security
JWT_SECRET  JWT_EXPIRES_IN  CSRF_SECRET  ENCRYPTION_KEY  COOKIE_DOMAIN
# database / cache / storage
DATABASE_URL  PGPOOL_MAX  REDIS_URL
MINIO_ENDPOINT  MINIO_PORT  MINIO_USE_SSL  MINIO_ACCESS_KEY  MINIO_SECRET_KEY  MINIO_BUCKET  MEDIA_PUBLIC_BASE_URL
POSTGRES_USER  POSTGRES_PASSWORD  POSTGRES_DB            # compose only
# whatsapp (Meta Cloud API)
META_APP_ID  META_APP_SECRET  META_API_VERSION  META_GRAPH_BASE_URL
WHATSAPP_PHONE_NUMBER_ID  WHATSAPP_WABA_ID  WHATSAPP_ACCESS_TOKEN  WHATSAPP_WEBHOOK_VERIFY_TOKEN
STAFF_ALERT_PHONE
# ai
DEEPSEEK_API_KEY  AI_REQUEST_TIMEOUT_MS      # provider, model, prompt, tools, limits live in the DB (AI Agent screen)
# optional, only if another provider is picked in the UI: OPENAI_API_KEY  ANTHROPIC_API_KEY  GEMINI_API_KEY
# distance
GOOGLE_MAPS_API_KEY            # optional; enables address geocoding + road distance
# gallery (Google Drive sync)
GDRIVE_FOLDER_ID  GDRIVE_API_KEY                # folder shared "anyone with link"; set before production
GALLERY_SYNC_CRON  GALLERY_MAX_IMAGE_PX
# workers
SEND_RETRY_LIMIT  BROADCAST_BATCH_SIZE  BROADCAST_SEND_DELAY_MS  AI_REPLY_DEBOUNCE_MS
# payments (optional)
UPI_VPA  UPI_PAYEE_NAME  RAZORPAY_KEY_ID  RAZORPAY_KEY_SECRET
```

Business settings (base pin, road factor, slabs, discount caps, advance %, working hours) live **in the DB**, editable in the UI, not in env.

## 6. Deployment

- `docker-compose.yml` with these services:
  - `postgres` (`pgvector/pgvector:pg15`, named volume)
  - `redis` (`redis:7-alpine`, AOF on)
  - `minio` (volume; a public-read bucket policy only on `gallery/`). **Added in M5.** Docker Hub no longer serves `minio/minio` (checked 2026-11-08), so pick the image then: the one Whapter's server already runs, or an S3-compatible alternative.
  - `api`, `worker` (the same Node image, different command)
  - `web` (multi-stage build → nginx serving the SPA and proxying `/api` and `/webhook` to `api`)
- Only `web` publishes a port. Postgres, Redis and MinIO stay on the internal network, so nothing clashes with Whapter's ports if they share a host.
- TLS: a host reverse proxy (Caddy or nginx) in front of `web`, terminating HTTPS for the domain. Meta requires HTTPS for webhooks.
- Migrations run as a one-shot `migrate` service before `api` and `worker` start.
- CI/CD: a GitHub Action builds the images, runs the tests, SSHes in, and runs `docker compose pull && docker compose up -d`. Same idea as Whapter's workflow, but with images instead of `git reset` on the server.
- **Host:** TO CONFIRM. Whapter's VPS (200.141.8.205) or a separate one. I won't touch the production server without asking.

## 7. Risks and open items

| Item | Owner | Blocking? |
|---|---|---|
| Real prices, package inclusions, the 3-frame vs 4-frame inconsistency | Client | Blocks go-live (dev uses TODO prices) |
| Gallery: Drive access (service account or public link), prices for the 301 unpriced photos, confirm the suspected third-party photo | Client | Blocks M5 UAT (import works without them) |
| Negotiation caps, distance slabs, base pin, max service km | Client | Blocks M5 UAT |
| Advance %, payment method, cancellation policy | Client | Blocks M7 |
| Meta Business verification and Cloud API access on +91 93925 34625 (coexistence?) | Client + us | Blocks M3 end-to-end |
| Domain and hosting choice | You | Blocks M10 |
| LLM provider and key | You | Blocks M6 live eval (mocked until then) |
| Languages (English only? Telugu/Hindi?) | Client | Affects the prompt |
