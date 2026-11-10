# Deploying and running BalloonsBuzz

This guide covers putting the platform on a server, connecting WhatsApp, monitoring, backups,
updates and recovery. Everything secret lives in `.env` on the server; nothing secret goes in git.

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Database (Postgres 17) | Supabase (hosted) | All business data. Reached over TLS through the Session pooler. |
| Gallery photos | Supabase Storage, public bucket `gallery` | WhatsApp downloads photos from here. Drive stays the original source. |
| `api` | Docker on the server | REST API, live updates (SSE), Meta webhook. |
| `worker` | Docker on the server | Replies, sending, reminders, broadcasts, Drive sync. Checks in every minute. |
| `web` | Docker on the server | nginx: the dashboard, forwarding `/api` and `/webhook` to `api`. Listens on `127.0.0.1:8080` only. |
| `backup` | Docker on the server | Daily encrypted database dump + photo mirror into `./backups`. |
| HTTPS | Caddy on the server (host) | Certificates from Let's Encrypt, renewed automatically. The only public door (ports 80/443). |

```
customer ─WhatsApp─▶ Meta ─HTTPS─▶ Caddy :443 ─▶ web (nginx) :8080 ─▶ api :4000 ─▶ Supabase
team ─browser────────────────────▶ Caddy :443 ─▶ web ─▶ dashboard / api           ▲
                                                worker ─────────────────────────────┘
```

## 2. Server

- Ubuntu 22.04 or 24.04, 2 vCPU, 2–4 GB RAM, 20 GB disk (photos live in Supabase, not here).
- Docker Engine with the compose plugin: <https://docs.docker.com/engine/install/ubuntu/>.
- Caddy: <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>.
- Firewall: allow 22 (SSH), 80 and 443 only. `sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable`.
- Docker publishes `web` on `127.0.0.1` only, so the firewall and Docker don't fight.

**Sharing Whapter's server?** It works: nothing here binds a public port. Pick a free `WEB_PORT`
(e.g. 8090) and add a site for the BalloonsBuzz domain to the proxy that already holds 80/443
there (a Caddy site block like `ops/caddy/Caddyfile`, or an nginx `server {}` with
`proxy_pass http://127.0.0.1:8090; proxy_buffering off;`). Don't start a second Caddy on 80/443.

## 3. Domain

Create a DNS **A record** for the dashboard host (for example `app.balloonsbuzz.com`) pointing
to the server's IP. Wait until `ping app.balloonsbuzz.com` shows that IP before starting Caddy,
or the certificate request fails.

## 4. First deploy

```bash
git clone <repo> /opt/balloonsbuzz && cd /opt/balloonsbuzz
cp .env.example .env && chmod 600 .env
nano .env        # see the list below
docker compose up -d --build          # migrate runs first, then api, worker, web, backup
docker compose ps                     # api/web "healthy", worker and backup "Up"
docker compose exec api node backend/scripts/create-owner.js --email owner@balloonsbuzz.com --name "Owner Name"
```
`create-owner` prints a generated password once: save it in a password manager. (Changing
passwords and inviting staff come with the Users screen, M2b.)

Production values in `.env` (the API refuses to start if the first four are unsafe):

| Setting | Value |
|---|---|
| `FRONTEND_URL` | `https://app.balloonsbuzz.com` (your domain, https) |
| `JWT_SECRET` | `openssl rand -hex 48` (new; never reuse the dev one) |
| `ENCRYPTION_KEY` | `openssl rand -hex 32`. **Keep a copy**: saved API keys/tokens can't be read without it. |
| `COOKIE_SECURE` | `true` |
| `DATABASE_URL`, `PGSSL=true` | Supabase → Connect → Session pooler URI |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | photo storage |
| `DEEPSEEK_API_KEY` | or paste it in AI Agent → Model & API key |
| `PUBLIC_BASE_URL` | same https address as `FRONTEND_URL` |
| `META_APP_ID`, `META_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | section 6 |
| `GDRIVE_API_KEY` | Drive sync (folder shared "anyone with the link") |
| `BACKUP_PASSPHRASE` | `openssl rand -base64 32`. **Keep a copy off the server** (password manager). |
| `WEB_PORT` | 8080, or a free port if the server is shared |

Then HTTPS:
```bash
sudo cp ops/caddy/Caddyfile /etc/caddy/Caddyfile   # edit the domain (and port if not 8080)
sudo mkdir -p /var/log/caddy && sudo systemctl reload caddy
curl -s https://app.balloonsbuzz.com/api/health   # {"status":"ok","db":"ok",...,"worker":"ok"}
```

## 5. Settings in the dashboard

Settings → Business: base location pin, advance %, UPI id, team alert phones, capacity and lead
time. Pricing & Rules: real prices, discount limits, distance slabs. AI Agent: turn the bot on
after the test chat looks right.

## 6. Connecting WhatsApp (developers.facebook.com)

No "allowed domains"/"safe origins" are needed: those are for Facebook Login. You need:

1. **Webhook** (WhatsApp → Configuration): callback URL `https://app.balloonsbuzz.com/webhook/whatsapp`,
   verify token = the `WHATSAPP_WEBHOOK_VERIFY_TOKEN` you put in `.env`. Press *Verify and save*,
   then **subscribe** to `messages` (and `message_template_status_update`).
2. **Permanent token**: Business Settings → System users → add a system user with
   `whatsapp_business_messaging` and `whatsapp_business_management`, generate a token, and paste
   it in **Settings → WhatsApp** in the dashboard (stored encrypted), with the Phone number ID and
   WhatsApp Business Account ID.
3. **App secret** (App settings → Basic) → `META_APP_SECRET` in `.env`, then
   `docker compose up -d`. Webhooks without a valid signature are refused.
4. Switch the app to **Live** mode.
5. Settings → WhatsApp → *Check connection*, send a test message, then Templates → *Submit to
   Meta* for the five recommended templates.

## 7. Monitoring

- **Uptime**: add a free monitor (UptimeRobot, Better Stack…) on
  `https://app.balloonsbuzz.com/api/health`, every 1–5 minutes, alerting by email/WhatsApp. It
  returns **503** when the database is unreachable or the worker has not checked in for 5
  minutes (so a stuck worker is caught too, not only a dead website). `"status":"busy"` means
  jobs are waiting more than 5 minutes: look at the worker logs.
- **Backups**: create a check at <https://healthchecks.io> (free) with a 1-day period and put
  its ping URL in `BACKUP_PING_URL`. You are alerted if a nightly backup doesn't happen.
- **Logs**: `docker compose logs -f api worker` (JSON lines; secrets are redacted). Docker keeps
  at most 5 × 10 MB per service; Caddy rolls its log at 10 MB × 5.

## 8. Backups and recovery

**What is backed up**: every night at `BACKUP_AT` (default 21:30 UTC = 03:00 IST) the `backup`
service writes

- `backups/db/bb-<time>.dump.enc`: the whole app database (`pg_dump`, encrypted with AES-256
  using `BACKUP_PASSPHRASE`) + a `.sha256` checksum. Kept `BACKUP_KEEP_DAYS` (14) days.
- `backups/gallery/…`: every gallery photo and thumbnail (only new files are downloaded).

Supabase also keeps its own daily backups on paid plans; ours are independent of it.

**Copy backups off the server** (a dead disk takes local backups with it). For example with
rclone to Google Drive, from the host's crontab, an hour after the backup:
```
30 22 * * *  rclone sync /opt/balloonsbuzz/backups gdrive:balloonsbuzz-backups --max-age 15d
```
The files are encrypted, so they are safe at rest anywhere.

**Commands**
```bash
docker compose run --rm backup backup     # take a backup now (e.g. before an update)
docker compose run --rm backup drill      # restore drill: restores the newest backup into a
                                          # temporary database, compares it with live, drops it
```
Run the drill **once a month** and after any change to the database setup. It must end with
`RESTORE DRILL PASSED`.

**Disaster recovery** (database lost or corrupted):
1. Create a new empty database: a new Supabase project, or `CREATE DATABASE bb_restored;` on the
   same server.
2. Restore into it (it refuses a non-empty database and refuses the live one):
   ```bash
   docker compose stop api worker
   docker compose run --rm backup restore /backups/db/bb-<time>.dump.enc "postgresql://…/bb_restored"
   ```
3. Point `DATABASE_URL` in `.env` at the restored database, then `docker compose up -d`.
4. Photos: if Supabase Storage was lost too, upload `backups/gallery/` back to the `gallery`
   bucket (same paths), or run Gallery → *Sync now* to re-import from Drive.

## 9. Updating

```bash
cd /opt/balloonsbuzz
docker compose run --rm backup backup   # safety copy first
git pull
docker compose up -d --build            # migrations run automatically before the API starts
curl -s https://app.balloonsbuzz.com/api/health
```
The worker gets 45 seconds to finish running jobs; the job queue lives in the database, so
nothing queued is lost during a restart.

**Rollback**: `git checkout <previous commit> && docker compose up -d --build`. If the update
included a database migration that must be undone, restore the safety backup instead (section 8).

## 10. Security notes

- Only Caddy faces the internet; `web` is bound to `127.0.0.1`; the API, worker and backup have
  no ports.
- `TRUST_PROXY=2` (set in `docker-compose.yml`) matches Caddy → nginx → API. If you put `web`
  directly on the internet without Caddy, set `TRUST_PROXY=1`, or per-IP limits can be dodged.
- Rate limits: 600 API requests/min per IP, 10 sign-in attempts per 15 min, and per-user limits
  on paid or external actions (AI test chat, imports, template sync, test messages, CSV exports).
- Customer files from WhatsApp only display inline when they are photos, audio or video; any
  other file downloads, sandboxed, so a hostile document cannot run in the dashboard.
- Supabase: Row Level Security is on for every table with no policies, so Supabase's public API
  exposes nothing. Keep the service-role key only in `.env`.
- `.env` should be `chmod 600`. Rotate `JWT_SECRET` to sign everyone out; never rotate
  `ENCRYPTION_KEY` without re-entering saved tokens and API keys afterwards.
