# poop-detector 💩

A Cloudflare Worker that watches **one or more** VOC sensors, stores each
reading every minute in D1 (tagged by sensor), alerts a Telegram chat when any
sensor flags an event, and answers live `/poop` and `/stats` commands.

## Multiple sensors

Sensors are configured as a JSON array in the `SOURCES` var — each entry has an
`id`, `label`, `url`, and optional per-sensor `threshold` (see [Config](#config)).
Every reading is stored with its sensor's `id` in a `source` column, alert state
is tracked per sensor, and most commands take an optional sensor id
(`/poop wberg`); omit it to target all sensors (or, for the aggregate commands
`/stats` and `/chart`, the first-listed one).

**Sensors don't all speak the same JSON.** The original sensor emits a rich
payload (VOC + MQ-135 pipelines, derived scores, a `toilet_like` flag). Simpler
sensors emit `voc_index`, `voc_avg_5min`/`voc_delta`/`voc_raw`, a sustained
`alarm` flag, and a few diagnostics (`alarm_state`, `event_count`,
`last_event_s`, `uptime_s`, `sht_ok`). The Worker **normalizes both** into one
row shape — fields a sensor doesn't provide are stored as `NULL` — so you do
**not** need to reflash anything to match. The alert fires on the sensor's
`alarm` flag when it emits one, otherwise on the rich sensor's `toilet_like`
flag, and each row keeps whichever raw fields its sensor sent.

## What it does

- **Cron (every minute):** for **each** configured sensor, `GET /json` → store
  the reading (tagged with the sensor's `source` id; `voc_index` plus whatever
  pipeline fields / scores / flags that sensor provides) in D1 → run the
  per-sensor alert checks → delete rows older than the retention window. Failed
  scrapes and `warmup` readings are skipped silently (logged only).
- **Toilet alert (edge-trigger + re-arm), per sensor:** a Telegram message the
  moment a sensor's alert flag turns **true** (`alarm` when the sensor emits one,
  else the rich sensor's `toilet_like`), then silent until it clears and re-arms.
  Tracked per sensor under the `toilet_armed:<id>` state key,
  so sensors alert independently. The message names the sensor and reports the
  current `voc_index` and `label`.
- **No VOC threshold alert:** the toilet alert is the only push alert.
  `THRESHOLD` / `REARM_MARGIN` are kept only to drive the `/safe`, `/status`,
  `/threshold`, and `/streak` displays — nothing fires on `voc_index` crossing a
  threshold.
- **Telegram commands:** most accept an optional leading sensor id (e.g.
  `/poop wberg`); omit it and the live commands report **all** sensors while the
  aggregate ones default to the first-listed sensor.
  - `/poop [source]` — live-fetches the sensor(s) and replies with VOC index,
    temp, humidity, and timestamp.
  - `/safe [source]` — live "can I go in?" verdict: 🟢 SAFE / 🟡 IFFY / 🔴 NOPE
    (`voc_index < threshold` → NOPE, `< threshold+15` → IFFY, else SAFE).
  - `/stats [source] [hours]` — min / avg / max + trend over the window (default 72h).
  - `/chart [source] [hours]` — ASCII sparkline of `voc_index` over the window (default 72h).
  - `/streak [source]` — time since the last alert event (stamped into the `state`
    table per sensor, so it survives the 72h rotation).
  - `/status` — for every sensor: last reading + age, stored row count, and alert state.
  - `/threshold` — reports each sensor's alert threshold and re-arm point.
  - `/help` (and `/start`) — lists the commands and configured sensors.
  - `/testalert [source]` — (hidden diagnostic) sends a sample toilet alert back
    to **the chat that ran it** (DM the bot for a private test), never to the group.
- **`GET /history`:** recent rows as JSON (public, read-only). Three modes:
  - `?hours=72` — relative window, last N hours (default 72, capped at retention).
  - `?at=2026-06-05T14:30:00+02:00` — the single reading closest to that instant.
  - `?from=…&to=…` — all readings in an explicit range (either bound optional).
  Times are ISO with offset (Sweden = `+02:00` CEST in summer); bare epoch ms also accepted.
  Add `?source=<id>` to scope to one sensor, and/or `?voc=<40` (or `<=`, `>`, `>=`, `=`;
  bare number = equal) to filter by `voc_index`. Rows span all sensors by default.
  Each row carries its `source`, the raw epoch-ms `ts`, a human `time` (ISO-8601
  with Stockholm offset), and every field its sensor's `/json` provides (fields a
  sensor doesn't send are `null`).

`voc_index` is the primary metric (the firmware no longer exposes the old single
`score` field). We read the JSON API directly rather than scraping HTML.

## Current deployment

Live at **https://poop-detector.wberg.com** (custom domain; `workers.dev` is
disabled). Alerts go to a private Telegram group via bot **@poop1337_bot**; the
group chat id is stored as the `ALERT_CHAT_ID` secret (not committed). Endpoints:

- `https://poop-detector.wberg.com/health`
- `https://poop-detector.wberg.com/history?hours=24` (public, read-only; also `?at=` / `?from=&to=` / `?source=<id>`)
- `https://poop-detector.wberg.com/telegram` (Telegram webhook)

## Config

`wrangler.jsonc` (`vars`, edit freely — change = redeploy):

| var | meaning | default |
|-----|---------|---------|
| `SOURCES` | JSON array of sensors; each `{id,label,url,threshold?}` | see below |
| `THRESHOLD` | fallback `voc_index` cutoff for sensors without their own | `40` |
| `REARM_MARGIN` | re-arm point shown as threshold + this (display only) | `2` |
| `RETENTION_HOURS` | how long to keep rows | `72` |

`SOURCES` is a JSON **string** (it's a wrangler var), one object per sensor:

```jsonc
"SOURCES": "[{\"id\":\"fozzie\",\"label\":\"fozzie\",\"url\":\"http://rapevan.se:20000\",\"threshold\":30},{\"id\":\"wberg\",\"label\":\"wberg\",\"url\":\"http://home2.wberg.com:10000\",\"threshold\":30}]"
```

- `id` — short key used in the `source` column, the `toilet_armed:<id>` /
  `last_incident_ts:<id>` state keys, and command args (`/poop wberg`).
- `label` — human name shown in Telegram messages.
- `url` — sensor base URL; the Worker appends `/json`.
- `threshold` — optional per-sensor cutoff; falls back to `THRESHOLD`.

> Legacy single-sensor deploys can still set `SOURCE_URL` instead of `SOURCES`
> (it's used only when `SOURCES` is unset, as one source with id `main`).

> The per-sensor alert flag (`toilet_like` on the rich sensor, `alarm` on the
> simple one) is the direct poop signal and fires regardless of the threshold.
> `THRESHOLD` only sets the NOPE/IFFY/SAFE cutoffs for `/safe` and the figures in
> `/status`, `/threshold`, and `/streak`. Recalibrate per sensor from
> `/stats <id> 48` once you've gathered a day or two.

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

# 3. Apply the schema (remote). NEW databases only.
npx wrangler d1 execute poop-detector --remote --file=./schema.sql
#    Upgrading an EXISTING db instead? Run the migrations in order (back up first):
#    - 0001: single-sensor -> multi-sensor (adds `source`, tags old rows 'fozzie')
#    - 0002: simple-sensor firmware update (adds `alarm` + diagnostics, drops `event`)
#    npx wrangler d1 execute poop-detector --remote --file=./migrations/0001_multi_source.sql
#    npx wrangler d1 execute poop-detector --remote --file=./migrations/0002_alarm_fields.sql

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
