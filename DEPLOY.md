# Deploying Reg-Poker Online

The app is one Node process holding live tables in memory, with a SQLite
file and uploads on disk. That means it needs a host that keeps **one
always-on instance with a persistent volume** — the configs here are for
Fly.io, with notes for alternatives at the end.

## Fly.io (recommended, ~$0–5/month)

### One-time setup

1. **Install flyctl and sign up**

   ```bash
   curl -L https://fly.io/install.sh | sh
   fly auth signup          # or: fly auth login
   ```

2. **Create the app** (from the repo root — a `fly.toml` is already here)

   ```bash
   fly launch --no-deploy --copy-config
   ```

   Accept the prompts. If the name `pineapple-poker` is taken, pick your own —
   flyctl updates `fly.toml` for you.

3. **Create the volume** (this is where the database and uploads live)

   ```bash
   fly volumes create pp_data --size 1
   ```

   Pick the same region as the app when asked.

4. **Deploy — the flag matters**

   ```bash
   fly deploy --ha=false
   ```

   `--ha=false` is **required**: Fly otherwise creates *two* machines, and
   this app must run exactly one — tables and socket connections live in
   the memory of a single process. Verify with:

   ```bash
   fly scale count 1   # should already be 1
   fly status
   ```

5. **Open it**

   ```bash
   fly open
   ```

   You now have `https://<your-app>.fly.dev` — share table links from there,
   and use the **📲 Install the app** button on the landing page (or your
   browser's install prompt) on each device.

### Optional configuration

```bash
# Real email delivery for the auto-invite list (otherwise invites are
# logged to the outbox and the UI says so):
fly secrets set SMTP_URL='smtps://user:pass@smtp.example.com:465'
fly secrets set SMTP_FROM='Reg-Poker Online <poker@example.com>'

# Contact address embedded in push-notification credentials:
fly secrets set VAPID_SUBJECT='mailto:you@example.com'
```

Push notifications need **no** setup: keys are generated on first use and
stored on the volume.

### Custom domain (optional)

```bash
fly certs add poker.example.com
```

Then add the DNS records flyctl prints. Done — HTTPS included.

### Things to know

- **Deploys restart the process and end any hand in progress.** Finished
  results are already saved, but deploy between game nights, not during
  one. Connected players see a polite "new version ready" toast rather
  than a forced reload.
- **Backups**: Fly snapshots volumes daily (`fly volumes snapshots list`).
  The whole database is the single file `/data/pineapple.db`.
- **Logs**: `fly logs` tails the server, including the invite outbox lines
  when SMTP isn't configured.

## Railway (alternative)

Create a project from the GitHub repo; Railway detects the Dockerfile.
Add a **volume** mounted at `/data`, set `PP_DB_PATH=/data/pineapple.db`
and `PP_UPLOAD_DIR=/data/uploads`, and keep the service on an always-on
plan (a sleeping instance kills live tables). One replica only.

## Any VPS with Docker (alternative)

```bash
docker build -t pineapple-poker .
docker run -d --name poker --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v /srv/poker-data:/data \
  -e PP_DB_PATH=/data/pineapple.db -e PP_UPLOAD_DIR=/data/uploads \
  pineapple-poker
```

Put Caddy or nginx in front for HTTPS (Caddyfile: `poker.example.com {
reverse_proxy 127.0.0.1:8080 }`). The app already trusts one proxy hop, so
invite links and rate limiting behave correctly behind it.

## Checking a deployment

1. `https://your-domain/healthz` returns `{"ok":true}`.
2. Create a table on one device, join it from a phone on mobile data (not
   your wifi) — that proves the public URL works end to end.
3. Install the app on your phone, enable the 🔔 at a table, close the app,
   and have someone bet at you — the "It's your turn" notification should
   arrive, and tapping it lands you back at the table.
