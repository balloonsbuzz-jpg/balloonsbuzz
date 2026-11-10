# BalloonsBuzz WhatsApp Platform

A WhatsApp sales assistant and team inbox for [BalloonsBuzz](https://www.balloonsbuzz.com), the balloon decoration business in Miyapur, Hyderabad. It is built on the patterns of Whapter, with a React + Node/Express + PostgreSQL stack.

Plan: [docs/PLAN.md](docs/PLAN.md) · Database: [db/README.md](db/README.md) (hosted on Supabase; local Docker Postgres also works) · Gallery rules: [docs/gallery-catalog.md](docs/gallery-catalog.md)

## Run locally (development)

```bash
cp .env.example .env                 # paste your Supabase Session-pooler URI + PGSSL=true
npm install
npm run migrate && npm run seed
npm run create-owner -- --email you@example.com --name "Your Name"   # prints a generated password once
npm run dev:api                      # API on :4000
npm run dev:web                      # dashboard on http://localhost:5173
```

The AI uses DeepSeek: put `DEEPSEEK_API_KEY` in `.env`, or paste a key in **AI Agent → Model & API key** (it is stored encrypted).

## Run the full stack (Docker)

```bash
docker compose up -d --build         # postgres, redis, migrate (one-shot), api, web
# open http://localhost:8080, then create the owner inside the api container:
docker compose exec api node backend/scripts/create-owner.js --email you@example.com --name "Your Name"
```

Only `web` publishes a port. In production, put HTTPS in front of it, because Meta webhooks require HTTPS.

## Tests

```bash
npm run test:db          # schema, constraints, seeds (throwaway databases)
npm test -w backend      # API: auth, RBAC, audit, AI agent + tools
npm test -w frontend     # UI units
```

## Status

| Milestone | State |
|---|---|
| Phase 0–2: discovery, plan, database | ✅ |
| M0 scaffold + Docker Compose | ✅ (photos live in Supabase Storage) |
| M2 auth, roles, audit | ✅ API + login. Users/Audit screens are next (M2b). |
| AI Agent + Tools screens | ✅ editable prompt with history, DeepSeek settings, editable tools |
| M3 WhatsApp in/out | ✅ webhooks, sending, Postgres job queue (needs the real number + public URL to go live) |
| M4 Inbox + handover | ✅ live inbox, take over / pause / resume, notes |
| M5 Gallery, pricing, discounts, distance | ✅ zip import (821 photos, 377 sendable), Drive sync (needs `GDRIVE_API_KEY`), quote engine, Pricing & Rules |
| M6 AI agent runtime | ✅ DeepSeek tool loop, outbound price guard, handover rules, test console (AI → Test chat), prompt in `prompts/balloonsbuzz-agent.md`; live eval in `docs/evals/` |
| M7 Leads and bookings | ✅ bot books from chat (advance + UPI), Bookings board, payments → auto-confirm + confirmation message, capacity warnings, Contacts & Leads |
| M8 Templates, broadcasts, follow-ups | next |

Gallery import from a Drive zip: `npm run gallery:import -- "D:\path	oolder.zip"` (safe to re-run).
