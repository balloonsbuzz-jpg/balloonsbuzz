# Hosting on Vercel (app.balloonsbuzz.com + api.balloonsbuzz.com)

Two Vercel projects from the same repository:

| Project | Root Directory | Domain | Config |
|---|---|---|---|
| Dashboard | `frontend` | `app.balloonsbuzz.com` | `frontend/vercel.json` (page routing, security headers) |
| API + Meta webhook | `backend` | `api.balloonsbuzz.com` | `backend/vercel.json` (Express, entry `src/server.js`) |

On the API project keep **Include files outside the root directory** on (Settings → Build and
Deployment): the API uses `db/ssl.js`. The dashboard calls `https://api.balloonsbuzz.com`
unless `VITE_API_URL` is set on its project.

## 1. API settings (Project → Settings → Environment Variables, Production)

| Name | Value |
|---|---|
| `DATABASE_URL` | Supabase → Connect → **Transaction pooler** (port 6543) |
| `DATABASE_LISTEN_URL` | Supabase → Connect → **Session pooler** (port 5432), for live inbox updates |
| `PGSSL` | `true` |
| `JWT_SECRET` | `openssl rand -hex 48` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` (keep a copy) |
| `FRONTEND_URL` | `https://app.balloonsbuzz.com` |
| `PUBLIC_BASE_URL` | `https://api.balloonsbuzz.com` |
| `META_APP_ID`, `META_APP_SECRET`, `META_API_VERSION` | the Meta app |
| `META_SIGNUP_CONFIG_ID` | the Embedded Signup configuration of that app |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | any long random string |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | photo storage |
| `DEEPSEEK_API_KEY` | AI replies |
| `CRON_SECRET` | `openssl rand -hex 32` |

Do **not** copy `FRONTEND_URL=http://localhost:5173` from a development `.env`, and leave
`COOKIE_SECURE` and `TRUST_PROXY` unset: Vercel gets safe defaults. `CORS_ORIGINS` is only for
additional dashboard addresses. Redeploy after changing settings.

If a required setting is missing, every API address answers 503 "not configured correctly" and
the function log names the setting.

## 2. Database

From a computer whose `.env` has the production `DATABASE_URL`, after every update that adds a
file in `db/migrations`:

```bash
npm run migrate
npm run seed            # first time
npm run create-owner -- --email owner@balloonsbuzz.com --name "Owner Name"   # first time
```

## 3. Background work

Vercel runs code only during requests. Replies, sending and AI answers run right after each
webhook or dashboard action. Things due later (reminders, follow-ups, scheduled broadcasts,
Drive sync, long retries) need a call every minute to `https://api.balloonsbuzz.com/internal/cron`
with the header `Authorization: Bearer <CRON_SECRET>`. Any one of:

- **Supabase** (free): enable `pg_cron` and `pg_net`, then run in the SQL editor
  `select cron.schedule('bb', '* * * * *', $$select net.http_get('https://api.balloonsbuzz.com/internal/cron', headers := '{"Authorization":"Bearer YOUR_CRON_SECRET"}'::jsonb)$$);`
- **cron-job.org** or similar, every minute, with that header.
- **Vercel Pro**: a cron job for `/internal/cron`, `* * * * *`. (The Hobby plan allows one run a day
  and refuses to deploy a faster schedule, so it is not in `vercel.json`.)

Large gallery imports can outlast the 5-minute limit: run them from a computer
(`npm run gallery:import`). For heavy use, run `node backend/src/worker.js` on any small server
with the same settings; nothing else changes.

Vercel's Hobby plan is for non-commercial use; a business needs Pro.

## 4. Meta app (developers.facebook.com)

**Facebook Login for Business → Settings**

- Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Strict Mode,
  Login with the JavaScript SDK: **Yes**
- Allowed Domains for the JavaScript SDK: `https://app.balloonsbuzz.com`
- Valid OAuth Redirect URIs: `https://app.balloonsbuzz.com/`

**App settings → Basic → App domains**: add `balloonsbuzz.com`.

**WhatsApp → Configuration → Webhook fields**: `messages`, `smb_message_echoes`,
`smb_app_state_sync`, `history` must be subscribed. Leave the callback URL as it is when the app
is shared with another product: each number connected here gets its own webhook address.

Meta cannot redirect template and account events (`message_template_status_update`,
`account_update`); those still go to the app's default callback. Use Templates → Sync for template
status, and Settings → WhatsApp → Check connection to see whether a phone was unlinked.

## 5. Connect the number

Dashboard → **Connect number** → choose → *Continue with Facebook*.

- **Keep using the WhatsApp Business app** (coexistence): the phone keeps working. Replies typed on
  the phone show in the inbox and the bot stays quiet in that chat. Contacts and up to 180 days of
  chats are imported once, if sharing was allowed. People who are only in the phone's contacts are
  left out of broadcasts until they message.
- **Use a new number**: registered automatically; enter the PIN if it already has one.

If a step fails the number is kept and *Finish setup* repeats the steps.

## 6. Check

```bash
curl -s https://api.balloonsbuzz.com/api/health
curl -si -X OPTIONS https://api.balloonsbuzz.com/api/auth/login -H 'Origin: https://app.balloonsbuzz.com' \
  -H 'Access-Control-Request-Method: POST' | grep -i access-control
```
