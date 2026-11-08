# BalloonsBuzz WhatsApp Platform

A WhatsApp sales assistant and team inbox for [BalloonsBuzz](https://www.balloonsbuzz.com), the balloon decoration business in Miyapur, Hyderabad. It is built on the patterns of Whapter, with a React + Node/Express + PostgreSQL stack.

Plan: [docs/PLAN.md](docs/PLAN.md) · Database: [db/README.md](db/README.md) · Gallery rules: [docs/gallery-catalog.md](docs/gallery-catalog.md)

## Run locally (development)

```bash
cp .env.example .env                 # fill in passwords and keys (see comments)
npm install
npm run db:up                        # Postgres 15 + pgvector on 127.0.0.1:55432
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
| M0 scaffold + Docker Compose | ✅ (object storage arrives with the gallery, M5) |
| M2 auth, roles, audit | ✅ API + login. Users/Audit screens are next (M2b). |
| AI Agent + Tools screens | ✅ editable prompt with history, DeepSeek settings, editable tools |
| M3 WhatsApp in/out | next |
