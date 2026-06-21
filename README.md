# poop-detector 💩

A Cloudflare Worker that watches the **Bathroom VOC Monitor** at
`http://rapevan.se:20000`, stores the reading every minute in D1, alerts a
Telegram chat when the sensor flags `toilet_like`, and answers live `/poop` and
`/stats` commands.

## What it does

- **Cron (every minute):** `GET /json` from the sensor → store the full reading
  (`voc_index` + the VOC/MQ-135 pipeline fields, derived scores, and boolean
  flags) in D1 → run the alert checks → delete rows older than the retention
  window. Failed scrapes and `warmup` readings are skipped silently (logged only).
- **Toilet alert (edge-trigger + re-arm):** a Telegram message the moment the
  sensor's `toilet_like` flag turns **true**, then silent until the flag clears
  and re-arms. Tracked under the `toilet_armed` state key. The message reports
  the current `voc_index` and `label`. This is the only live alert.
- **No VOC threshold alert:** the toilet alert is the only push alert.
  `THRESHOLD` / `REARM_MARGIN` are kept only to drive the `/safe`, `/status`,
  `/threshold`, and `/streak` displays — nothing fires on `voc_index` crossing a
  threshold.
- **Telegram commands:**
  - `/poop` — live-fetches the sensor and replies with VOC index, temp,
    humidity, and timestamp.
  - `/safe` — live "can I go in?" verdict: 🟢 SAFE / 🟡 IFFY / 🔴 NOPE
    (`voc_index < THRESHOLD` → NOPE, `< THRESHOLD+15` → IFFY, else SAFE).
  - `/stats [hours]` — min / avg / max + trend over the window (default 72h).
  - `/chart [hours]` — ASCII sparkline of `voc_index` over the window (default 72h).
  - `/streak` — time since the last alert event (stamped into the `state` table,
    so it survives the 72h rotation).
  - `/status` — last reading + age, stored row count, and current alert state.
  - `/threshold` — reports the current alert threshold and re-arm point.
  - `/help` (and `/start`) — lists the commands.
  - `/testalert` — (hidden diagnostic) sends a sample toilet alert back to **the
    chat that ran it** (DM the bot for a private test), never to the group.
- **`GET /history`:** recent rows as JSON (public, read-only). Three modes:
  - `?hours=72` — relative window, last N hours (default 72, capped at retention).
  - `?at=2026-06-05T14:30:00+02:00` — the single reading closest to that instant.
  - `?from=…&to=…` — all readings in an explicit range (either bound optional).
  Times are ISO with offset (Sweden = `+02:00` CEST in summer); bare epoch ms also accepted.
  Add `?voc=<40` (or `<=`, `>`, `>=`, `=`; bare number = equal) to any mode to filter by `voc_index`.
  Each row carries both the raw epoch-ms `ts` and a human `time` (ISO-8601 with
  Stockholm offset, e.g. `2026-06-05T07:30:00+02:00`), plus every field from the
  sensor's `/json` (VOC + MQ-135 pipeline, derived scores, boolean flags).

`voc_index` is the primary metric (the firmware no longer exposes the old single
`score` field). We read the JSON API directly rather than scraping HTML.

## Current deployment

Live at **https://poop-detector.wberg.com** (custom domain; `workers.dev` is
disabled). Alerts go to a private Telegram group via bot **@poop1337_bot**; the
group chat id is stored as the `ALERT_CHAT_ID` secret (not committed). Endpoints:

- `https://poop-detector.wberg.com/health`
- `https://poop-detector.wberg.com/history?hours=24` (public, read-only; also `?at=` / `?from=&to=`)
- `https://poop-detector.wberg.com/telegram` (Telegram webhook)

## Config

`wrangler.jsonc` (`vars`, edit freely — change = redeploy):

| var | meaning | default |
|-----|---------|---------|
| `SOURCE_URL` | sensor base URL | `http://rapevan.se:20000` |
| `THRESHOLD` | `voc_index` cutoff shown by `/safe`, `/status`, `/threshold`, `/streak` | `40` |
| `REARM_MARGIN` | re-arm point shown as THRESHOLD + this (display only) | `2` |
| `RETENTION_HOURS` | how long to keep rows | `72` |

> The `voc_index` baseline sits at ~92–110. There is no VOC-threshold alert, so
> `THRESHOLD` just sets the NOPE/IFFY/SAFE cutoffs for `/safe` and the figures
> shown by `/status`, `/threshold`, and `/streak`. The `toilet_like` alert is the
> direct poop signal and fires regardless of this threshold. Recalibrate from
> `/stats 48` once you've gathered a day or two.

Routing is pinned to the custom domain in `wrangler.jsonc`:

```jsonc
"workers_dev": false,
"routes": [{ "pattern": "poop-detector.wberg.com", "custom_domain": true }]
```

Secrets (never in the repo — set with `wrangler secret put`):

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `WEBHOOK_SECRET` — random string; Telegram echoes it back in a header
- `ALERT_CHAT_ID` — chat id that receives push alerts (kept secret to avoid
  exposing the private group id)

> Note: this repo intentionally has **no `package.json`** committed. Step 1 below
> generates it via `npm`.

## Setup

```bash
# 1. Config + dependencies (wrangler.jsonc is gitignored; copy the template)
cp wrangler.jsonc.example wrangler.jsonc
npm install -D wrangler typescript @cloudflare/workers-types

# 2. Create the D1 database, then paste the printed database_id into wrangler.jsonc
#    (also set your own custom domain in wrangler.jsonc routes, or drop it)
npx wrangler d1 create poop-detector

# 3. Apply the schema (remote)
npx wrangler d1 execute poop-detector --remote --file=./schema.sql

# 4. Set secrets (ALERT_CHAT_ID: see "Finding the chat id" below)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ALERT_CHAT_ID

# 5. Deploy
npx wrangler deploy
```

### Point Telegram at the Worker

The Worker serves on the custom domain `poop-detector.wberg.com` (the `wberg.com`
zone must be in the same Cloudflare account; `custom_domain: true` lets wrangler
manage its DNS record + cert).

```bash
# Register the webhook with the same secret you stored as WEBHOOK_SECRET
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://poop-detector.wberg.com/telegram" \
  -d "secret_token=<WEBHOOK_SECRET>"

# (optional) nice command menu in Telegram
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setMyCommands" \
  -H "content-type: application/json" \
  -d '{"commands":[{"command":"poop","description":"Live reading"},{"command":"stats","description":"Stats over N hours"}]}'
```

### Finding the chat id

The id format depends on chat type — get it wrong and sends fail with
`chat not found`:

- **Private DM** with the bot → your bare positive user id (e.g. `123456789`).
  The bot can only DM you after you've sent it `/start` first.
- **Basic group** → bare negative id (e.g. `-123456789`).
- **Supergroup / channel** → `-100`-prefixed (e.g. `-100123456789`).

To discover it: while **no webhook is set** (`deleteWebhook` first), send a
message in the chat, then read `result[].message.chat.id` from
`https://api.telegram.org/bot<TOKEN>/getUpdates`. For a **public** channel/group
you can skip that and call `getChat?chat_id=@username`. Re-run `setWebhook`
afterward. (Note: the Worker handles `message` updates, so `/poop` and `/stats`
work in DMs and groups, not broadcast channels.)

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in real secrets
npx wrangler dev
# trigger the cron handler manually:
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
# check history:
curl "http://localhost:8787/history?hours=24"
```

For local D1, also run the schema against the local db:
`npx wrangler d1 execute poop-detector --local --file=./schema.sql`
