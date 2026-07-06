/**
 * poop-detector — Cloudflare Worker (multi-sensor)
 *
 * - scheduled() runs every minute: for EACH configured sensor it fetches /json,
 *   stores the reading in D1 (tagged with the sensor's `source` id), runs the
 *   per-source alert state machine, then rotates out old rows.
 * - fetch() serves the Telegram webhook (/poop, /stats, …) and a public
 *   /history JSON endpoint.
 *
 * Sensors don't all speak the same JSON:
 *   - the original sensor emits a rich payload (VOC + MQ-135 pipelines, derived
 *     scores, a `toilet_like` flag, …);
 *   - newer/simpler sensors emit voc_index + voc_avg_5min/voc_delta/voc_raw and
 *     a sustained `alarm` flag (plus alarm_state, event_count, last_event_s,
 *     uptime_s, sht_ok).
 * fetchReading() normalizes both into one Reading shape; fields a given sensor
 * doesn't provide are stored as NULL. The alert fires on the sensor's `alarm`
 * flag when it emits one, otherwise on the rich sensor's `toilet_like` flag.
 */

export interface Env {
  DB: D1Database;
  // secrets
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ALERT_CHAT_ID: string;
  // vars (arrive as strings)
  //   SOURCES: JSON array of {id,label,url,threshold?}; preferred.
  //   SOURCE_URL: legacy single-sensor fallback used only when SOURCES is unset.
  SOURCES?: string;
  SOURCE_URL?: string;
  THRESHOLD: string;
  REARM_MARGIN: string;
  RETENTION_HOURS: string;
}

/** A configured sensor endpoint. */
interface Source {
  id: string;       // short key used in storage, alert-state keys, and commands
  label: string;    // human name shown in messages
  url: string;      // base URL (we append /json)
  threshold: number; // voc_index cutoff for this sensor's /safe & /status display
}

interface Reading {
  source: string;
  voc_index: number;
  temperature_c: number | null;
  humidity_pct: number | null;
  label: string;
  warmup: boolean;

  // Alarm / event tracking (simple sensor; NULL when the sensor omits them).
  // `alarm` is the sustained alarm output and, when present, is what the alert
  // fires on (see evaluateToiletAlert).
  alarm: boolean | null;
  alarm_state: string | null;
  event_count: number | null;
  last_event_s: number | null;
  uptime_s: number | null;
  sht_ok: boolean | null;

  // VOC pipeline (rich sensor)
  voc_fast: number | null;
  voc_slow: number | null;
  voc_baseline: number | null;
  voc_jump_pct: number | null;
  // VOC extras (simple sensor)
  voc_avg_5min: number | null;
  voc_delta: number | null;
  voc_raw: number | null;

  // MQ-135 gas sensor (rich sensor)
  mq135_raw: number | null;
  mq135_fast: number | null;
  mq135_slow: number | null;
  mq135_baseline: number | null;
  mq135_jump_pct: number | null;

  // Derived event scores (rich sensor)
  toilet_score: number | null;
  ipa_score: number | null;

  // Boolean flags (rich sensor; default false when absent)
  baseline_ready: boolean;
  seeding: boolean;
  toilet_like: boolean;
  ipa_like: boolean;
  suppressed: boolean;
  needs_cleaning: boolean;
}

const FETCH_TIMEOUT_MS = 10_000;

// Fallback used only if a source has no threshold and env.THRESHOLD is unset.
const DEFAULT_THRESHOLD = 40;

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/telegram") {
      return handleTelegram(req, env);
    }
    if (req.method === "GET" && url.pathname === "/history") {
      return handleHistory(env, url);
    }
    if (url.pathname === "/health") {
      return new Response("ok\n");
    }
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Source config
// ---------------------------------------------------------------------------

/**
 * Parse the configured sensors. Prefers the `SOURCES` JSON var; falls back to a
 * single source built from the legacy `SOURCE_URL` so old deployments keep
 * working until they switch to SOURCES.
 */
function getSources(env: Env): Source[] {
  const fallbackThreshold = numOrDefault(env.THRESHOLD, DEFAULT_THRESHOLD);
  const raw = env.SOURCES?.trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw) as Array<Partial<Source>>;
      const out: Source[] = arr
        .filter((s) => s && typeof s.url === "string" && s.url)
        .map((s, i) => ({
          id: String(s.id ?? `src${i}`),
          label: String(s.label ?? s.id ?? `Source ${i}`),
          url: String(s.url),
          threshold:
            typeof s.threshold === "number" && Number.isFinite(s.threshold)
              ? s.threshold
              : fallbackThreshold,
        }));
      if (out.length) return out;
      console.error("SOURCES parsed to an empty list; falling back to SOURCE_URL");
    } catch (e) {
      console.error("invalid SOURCES json:", e instanceof Error ? e.message : e);
    }
  }
  return [{ id: "main", label: "Sensor", url: env.SOURCE_URL ?? "", threshold: fallbackThreshold }];
}

/** Find a source by id (case-insensitive). */
function sourceById(sources: Source[], id: string | undefined): Source | undefined {
  if (!id) return undefined;
  const lc = id.toLowerCase();
  return sources.find((s) => s.id.toLowerCase() === lc);
}

// ---------------------------------------------------------------------------
// Cron: for each source scrape -> store -> alert, then rotate
// ---------------------------------------------------------------------------

async function tick(env: Env): Promise<void> {
  const sources = getSources(env);

  for (const source of sources) {
    let reading: Reading;
    try {
      reading = await fetchReading(source);
    } catch (err) {
      // Skip + log silently (per design): a failed scrape writes nothing, no alert.
      console.error(`[${source.id}] scrape failed:`, err instanceof Error ? err.message : err);
      continue;
    }

    if (reading.warmup) {
      console.log(`[${source.id}] sensor warming up, skipping reading`);
      continue;
    }

    const ts = Date.now();
    await storeReading(env, reading, ts);
    await evaluateToiletAlert(env, source, reading, ts);
  }

  // Inline rotation across all sources: drop anything older than the retention window.
  const cutoff = Date.now() - hoursToMs(numOrDefault(env.RETENTION_HOURS, 72));
  await env.DB.prepare(`DELETE FROM readings WHERE ts < ?`).bind(cutoff).run();
}

async function storeReading(env: Env, r: Reading, ts: number): Promise<void> {
  const b01 = (v: boolean): number => (v ? 1 : 0);
  // Nullable boolean -> 0/1/NULL (fields the sensor doesn't emit stay NULL).
  const b01n = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);
  await env.DB.prepare(
    `INSERT INTO readings (
       source, ts, voc_index, temperature_c, humidity_pct, label,
       alarm, alarm_state, event_count, last_event_s, uptime_s, sht_ok,
       voc_fast, voc_slow, voc_baseline, voc_jump_pct, voc_avg_5min, voc_delta, voc_raw,
       mq135_raw, mq135_fast, mq135_slow, mq135_baseline, mq135_jump_pct,
       toilet_score, ipa_score,
       baseline_ready, seeding, toilet_like, ipa_like, suppressed, needs_cleaning
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      r.source, ts, r.voc_index, r.temperature_c, r.humidity_pct, r.label,
      b01n(r.alarm), r.alarm_state, r.event_count, r.last_event_s, r.uptime_s, b01n(r.sht_ok),
      r.voc_fast, r.voc_slow, r.voc_baseline, r.voc_jump_pct, r.voc_avg_5min, r.voc_delta, r.voc_raw,
      r.mq135_raw, r.mq135_fast, r.mq135_slow, r.mq135_baseline, r.mq135_jump_pct,
      r.toilet_score, r.ipa_score,
      b01(r.baseline_ready), b01(r.seeding), b01(r.toilet_like),
      b01(r.ipa_like), b01(r.suppressed), b01(r.needs_cleaning),
    )
    .run();
}

/**
 * Edge-trigger toilet alert, per source: one Telegram message when the sensor's
 * alert flag turns on, then silent until it clears and re-arms. The flag is the
 * sensor's sustained `alarm` when it emits one, otherwise the rich sensor's
 * `toilet_like` flag. State is tracked under a per-source `toilet_armed:<id>` key
 * so sensors alert independently.
 */
async function evaluateToiletAlert(env: Env, source: Source, reading: Reading, ts: number): Promise<void> {
  // Prefer `alarm` (only null when the sensor doesn't emit it); else toilet_like.
  const trigger = reading.alarm ?? reading.toilet_like;
  const armKey = `toilet_armed:${source.id}`;
  const armed = await getArmed(env, armKey);

  if (armed && trigger) {
    await sendTelegram(env, env.ALERT_CHAT_ID, toiletAlertMessage(source, reading));
    await setArmed(env, false, armKey);
    // Stamp the incident for /streak (survives rotation); per-source key.
    await setStateValue(env, `last_incident_ts:${source.id}`, String(ts));
  } else if (!armed && !trigger) {
    // Flag cleared: re-arm silently for the next alarm.
    await setArmed(env, true, armKey);
  }
}

/** The toilet-alert message body, shared by the live alert and the /testalert self-test. */
function toiletAlertMessage(source: Source, r: Reading): string {
  return `🚽💩 <b>Toilet activity detected!</b>\n📍 ${esc(source.label)}\nVOC ${fmt(r.voc_index)} — ${esc(r.label)}.`;
}

// ---------------------------------------------------------------------------
// Telegram webhook
// ---------------------------------------------------------------------------

async function handleTelegram(req: Request, env: Env): Promise<Response> {
  // Only Telegram knows the secret token (set via setWebhook).
  if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden\n", { status: 403 });
  }

  const update = (await req.json().catch(() => null)) as TelegramUpdate | null;
  const msg = update?.message ?? update?.edited_message;
  const chatId = msg?.chat?.id;
  const text = msg?.text ?? "";

  // Ignore anything that isn't a text message (always 200 so Telegram stops retrying).
  if (!chatId || !text) return new Response("ok\n");

  const sources = getSources(env);

  // "/poop@MyBot home2" -> cmd "/poop", args ["home2"]
  const tokens = text.trim().split(/\s+/);
  const cmd = tokens[0].split("@")[0].toLowerCase();
  const args = tokens.slice(1);

  if (cmd === "/poop") {
    await replyPoop(env, chatId, sources, args);
  } else if (cmd === "/stats") {
    await replyStats(env, chatId, sources, args);
  } else if (cmd === "/status") {
    await replyStatus(env, chatId, sources);
  } else if (cmd === "/threshold") {
    await replyThreshold(env, chatId, sources);
  } else if (cmd === "/safe") {
    await replySafe(env, chatId, sources, args);
  } else if (cmd === "/streak") {
    await replyStreak(env, chatId, sources, args);
  } else if (cmd === "/chart") {
    await replyChart(env, chatId, sources, args);
  } else if (cmd === "/testalert") {
    await replyTestAlert(env, chatId, sources, args);
  } else if (cmd === "/help" || cmd === "/start") {
    await replyHelp(env, chatId, sources);
  }

  return new Response("ok\n");
}

/**
 * Split command args into an optional leading source id and the rest.
 * `/stats home2 24` -> {source: home2, rest: ["24"]}
 * `/stats 24`       -> {source: undefined, rest: ["24"]}
 */
function splitSourceArg(sources: Source[], args: string[]): { source: Source | undefined; rest: string[] } {
  const s = sourceById(sources, args[0]);
  return s ? { source: s, rest: args.slice(1) } : { source: undefined, rest: args };
}

/** /poop: live fetch right now and report the fresh reading for one or all sources. */
async function replyPoop(env: Env, chatId: number, sources: Source[], args: string[]): Promise<void> {
  const targets = pickTargets(sources, args[0]);
  const blocks = await Promise.all(
    targets.map(async (source) => {
      try {
        const r = await fetchReading(source);
        if (r.warmup) return `${srcHeader(sources, source)}⚠️ ⏳ Warming up, no valid reading yet.`;
        const emoji = r.voc_index >= source.threshold ? "✅" : "💩";
        return [
          `${srcHeader(sources, source)}${emoji} <b>VOC: ${fmt(r.voc_index)}</b> (${esc(r.label)})`,
          `Temp: ${fmtN(r.temperature_c)}°C · Humidity: ${fmtN(r.humidity_pct)}%`,
        ].join("\n");
      } catch {
        return `${srcHeader(sources, source)}⚠️ Couldn't reach the sensor right now.`;
      }
    }),
  );
  await sendTelegram(env, chatId, `${blocks.join("\n\n")}\n🕒 ${nowLocal()}`);
}

/** /stats [source] [hours]: min/max/avg + trend over the window (default 72h, capped at retention). */
async function replyStats(env: Env, chatId: number, sources: Source[], args: string[]): Promise<void> {
  const { source, rest } = splitSourceArg(sources, args);
  const target = source ?? sources[0];

  const cap = numOrDefault(env.RETENTION_HOURS, 72);
  const arg = parseInt(rest[0] ?? "", 10);
  const hours = Math.min(Number.isFinite(arg) && arg > 0 ? arg : 72, cap);
  const since = Date.now() - hoursToMs(hours);

  const [agg, firstRow, lastRow] = await env.DB.batch<{ voc_index: number } & {
    n: number; mn: number | null; mx: number | null; av: number | null;
  }>([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(voc_index) AS mn, MAX(voc_index) AS mx, AVG(voc_index) AS av
       FROM readings WHERE source = ? AND ts >= ?`,
    ).bind(target.id, since),
    env.DB.prepare(`SELECT voc_index FROM readings WHERE source = ? AND ts >= ? ORDER BY ts ASC LIMIT 1`).bind(target.id, since),
    env.DB.prepare(`SELECT voc_index FROM readings WHERE source = ? AND ts >= ? ORDER BY ts DESC LIMIT 1`).bind(target.id, since),
  ]).then((rs) => rs.map((r) => r.results[0]));

  if (!agg || agg.n === 0) {
    await sendTelegram(env, chatId, `📊 ${srcTag(sources, target)}No data yet for the last ${hours}h.`);
    return;
  }

  const delta = (lastRow?.voc_index ?? 0) - (firstRow?.voc_index ?? 0);
  const arrow = delta > 1 ? "📈" : delta < -1 ? "📉" : "➡️";

  const msg = [
    `📊 <b>${srcTag(sources, target)}Last ${hours}h</b> (${agg.n} readings)`,
    `VOC — min ${fmt(agg.mn!)} · avg ${fmt(agg.av!)} · max ${fmt(agg.mx!)}`,
    `Trend ${arrow} ${fmt(firstRow?.voc_index ?? 0)} → ${fmt(lastRow?.voc_index ?? 0)} (${delta >= 0 ? "+" : ""}${fmt(delta)})`,
  ].join("\n");

  await sendTelegram(env, chatId, msg);
}

/** /status: for each source, last reading, age, stored count, and current alert state. */
async function replyStatus(env: Env, chatId: number, sources: Source[]): Promise<void> {
  const blocks = await Promise.all(
    sources.map(async (source) => {
      const last = await env.DB.prepare(
        `SELECT ts, voc_index, label FROM readings WHERE source = ? ORDER BY ts DESC LIMIT 1`,
      ).bind(source.id).first<{ ts: number; voc_index: number; label: string }>();
      const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM readings WHERE source = ?`)
        .bind(source.id).first<{ n: number }>();
      const armed = await getArmed(env, `toilet_armed:${source.id}`);
      const margin = numOrDefault(env.REARM_MARGIN, 0);

      if (!last) return `${srcHeader(sources, source, true)}No readings stored yet.`;

      const ageMin = Math.round((Date.now() - last.ts) / 60_000);
      return [
        srcHeader(sources, source, true).trimEnd(),
        `Last: <b>${fmt(last.voc_index)}</b> (${esc(last.label)}) — ${ageMin}m ago`,
        `Stored: ${total?.n ?? 0} · Alerts: ${armed ? "armed ✅" : "fired 🔕"}`,
        `Threshold: ${fmt(source.threshold)} (re-arm ≥ ${fmt(source.threshold + margin)})`,
      ].join("\n");
    }),
  );
  await sendTelegram(env, chatId, `📟 <b>Status</b>\n\n${blocks.join("\n\n")}`);
}

/** /threshold: report each source's alert threshold and re-arm point. */
async function replyThreshold(env: Env, chatId: number, sources: Source[]): Promise<void> {
  const margin = numOrDefault(env.REARM_MARGIN, 0);
  const lines = sources.map(
    (s) =>
      `${srcTag(sources, s)}<b>${fmt(s.threshold)}</b> — NOPE if VOC &lt; ${fmt(s.threshold)}; re-arm ≥ ${fmt(s.threshold + margin)}`,
  );
  await sendTelegram(env, chatId, `🎚️ <b>Thresholds</b>\n${lines.join("\n")}`);
}

/** /safe [source]: live "can I go in?" verdict from the current VOC, per source. */
async function replySafe(env: Env, chatId: number, sources: Source[], args: string[]): Promise<void> {
  const targets = pickTargets(sources, args[0]);
  const blocks = await Promise.all(
    targets.map(async (source) => {
      try {
        const r = await fetchReading(source);
        if (r.warmup) return `${srcHeader(sources, source)}⚠️ ⏳ Warming up — can't call it yet.`;
        let verdict: string;
        if (r.voc_index < source.threshold) verdict = "🔴 <b>NOPE</b> — abort mission";
        else if (r.voc_index < source.threshold + 15) verdict = "🟡 <b>IFFY</b> — enter with caution";
        else verdict = "🟢 <b>SAFE</b> — all clear";
        return `${srcHeader(sources, source)}${verdict}\nVOC ${fmt(r.voc_index)} (${esc(r.label)})`;
      } catch {
        return `${srcHeader(sources, source)}⚠️ Couldn't reach the sensor right now.`;
      }
    }),
  );
  await sendTelegram(env, chatId, blocks.join("\n\n"));
}

/** /streak [source]: time since the last alert event (persisted across rotation), per source. */
async function replyStreak(env: Env, chatId: number, sources: Source[], args: string[]): Promise<void> {
  const targets = pickTargets(sources, args[0]);
  const lines = await Promise.all(
    targets.map(async (source) => {
      const tsStr = await getStateValue(env, `last_incident_ts:${source.id}`);
      if (!tsStr) return `${srcTag(sources, source)}🏆 No incidents on record — spotless! 🎉`;
      const elapsed = Date.now() - Number(tsStr);
      return `${srcTag(sources, source)}🏆 <b>${fmtDuration(elapsed)}</b> since the last incident (${localFromMs(Number(tsStr))}).`;
    }),
  );
  await sendTelegram(env, chatId, lines.join("\n"));
}

/** /chart [source] [hours]: ASCII sparkline of VOC over the window (default 72h). */
async function replyChart(env: Env, chatId: number, sources: Source[], args: string[]): Promise<void> {
  const { source, rest } = splitSourceArg(sources, args);
  const target = source ?? sources[0];

  const cap = numOrDefault(env.RETENTION_HOURS, 72);
  const arg = parseInt(rest[0] ?? "", 10);
  const hours = Math.min(Number.isFinite(arg) && arg > 0 ? arg : 72, cap);
  const since = Date.now() - hoursToMs(hours);

  const { results } = await env.DB.prepare(
    `SELECT ts, voc_index FROM readings WHERE source = ? AND ts >= ? ORDER BY ts ASC`,
  )
    .bind(target.id, since)
    .all<{ ts: number; voc_index: number }>();

  if (results.length === 0) {
    await sendTelegram(env, chatId, `📈 ${srcTag(sources, target)}No data yet for the last ${hours}h.`);
    return;
  }

  const cols = 24;
  const bucketMs = hoursToMs(hours) / cols;
  const sums = new Array<number>(cols).fill(0);
  const counts = new Array<number>(cols).fill(0);
  for (const row of results) {
    const idx = Math.min(cols - 1, Math.max(0, Math.floor((row.ts - since) / bucketMs)));
    sums[idx] += row.voc_index;
    counts[idx] += 1;
  }
  const vals = sums.map((s, i) => (counts[i] ? s / counts[i] : null));
  const present = vals.filter((v): v is number => v !== null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const last = present[present.length - 1];

  const blocks = "▁▂▃▄▅▆▇█";
  const spark = vals
    .map((v) => {
      if (v === null) return " ";
      if (max === min) return blocks[blocks.length - 1];
      return blocks[Math.round(((v - min) / (max - min)) * (blocks.length - 1))];
    })
    .join("");

  const msg =
    `📈 <b>${srcTag(sources, target)}VOC · last ${hours}h</b>\n` +
    `<pre>${spark}</pre>` +
    `min ${fmt(min)} · max ${fmt(max)} · now ${fmt(last)}`;
  await sendTelegram(env, chatId, msg);
}

/**
 * /testalert [source]: safe self-test — sends the toilet-alert message to whoever
 * ran the command (so DM the bot to get it privately), never to the group
 * ALERT_CHAT_ID. Uses the live reading so the formatting matches a real alert.
 */
async function replyTestAlert(env: Env, chatId: number, sources: Source[], args: string[]): Promise<void> {
  const target = sourceById(sources, args[0]) ?? sources[0];
  try {
    const r = await fetchReading(target);
    await sendTelegram(
      env,
      chatId,
      `🧪 <i>Test — this is exactly what a toilet alert looks like (current live values):</i>\n\n${toiletAlertMessage(target, r)}`,
    );
  } catch {
    await sendTelegram(env, chatId, "⚠️ Couldn't reach the sensor for the test.");
  }
}

/** /help (and /start): list the available commands and configured sources. */
async function replyHelp(env: Env, chatId: number, sources: Source[]): Promise<void> {
  const ids = sources.map((s) => `<code>${esc(s.id)}</code> (${esc(s.label)})`).join(", ");
  const msg = [
    "💩 <b>poop-detector</b>",
    `Sensors: ${ids}`,
    "Add a sensor id to target one (else all / the primary):",
    "/poop [source] — live sensor reading",
    "/safe [source] — can I go in right now?",
    "/stats [source] [hours] — min/avg/max + trend (default 72)",
    "/chart [source] [hours] — sparkline of VOC (default 72)",
    "/streak [source] — time since the last incident",
    "/status — last reading, count, alert state (all sensors)",
    "/threshold — current alert thresholds (all sensors)",
    "/help — this message",
  ].join("\n");
  await sendTelegram(env, chatId, msg);
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

/** Targets for "all or one" commands: [named] if the arg matches a source, else all sources. */
function pickTargets(sources: Source[], idArg: string | undefined): Source[] {
  const s = sourceById(sources, idArg);
  return s ? [s] : sources;
}

/** Inline label prefix like "🏠 Home 2: " — only when more than one source is configured. */
function srcTag(sources: Source[], source: Source): string {
  return sources.length > 1 ? `${esc(source.label)}: ` : "";
}

/** Block header line like "📍 <b>Home 2</b>\n" — only when more than one source is configured. */
function srcHeader(sources: Source[], source: Source, always = false): string {
  if (sources.length <= 1 && !always) return "";
  return `📍 <b>${esc(source.label)}</b>\n`;
}

// ---------------------------------------------------------------------------
// History JSON endpoint
// ---------------------------------------------------------------------------

async function handleHistory(env: Env, url: URL): Promise<Response> {
  // Public, read-only endpoint — no token required.
  // Three time modes (checked in this order):
  //   ?at=<ISO>            -> the single reading closest to that instant
  //   ?from=<ISO>&to=<ISO> -> all readings in [from, to] (either bound optional)
  //   ?hours=N             -> all readings in the last N hours (default 72)
  // Any mode can add ?source=<id> to scope to one sensor, and ?voc=<op><n>
  // (e.g. <40, >=40, =40) to filter by voc_index.
  const cols =
    `source, ts, voc_index, temperature_c, humidity_pct, label, ` +
    `alarm, alarm_state, event_count, last_event_s, uptime_s, sht_ok, ` +
    `voc_fast, voc_slow, voc_baseline, voc_jump_pct, voc_avg_5min, voc_delta, voc_raw, ` +
    `mq135_raw, mq135_fast, mq135_slow, mq135_baseline, mq135_jump_pct, ` +
    `toilet_score, ipa_score, ` +
    `baseline_ready, seeding, toilet_like, ipa_like, suppressed, needs_cleaning`;

  // Build the shared filter (source + voc), applied on top of whichever time mode runs.
  const filters: string[] = [];
  const filterParams: (number | string)[] = [];

  const sourceRaw = url.searchParams.get("source");
  if (sourceRaw !== null) {
    filters.push(`source = ?`);
    filterParams.push(sourceRaw);
  }

  const vocRaw = url.searchParams.get("voc");
  if (vocRaw !== null) {
    const sc = parseVoc(vocRaw);
    if (sc === null) return Response.json({ error: `invalid 'voc' filter: ${vocRaw}` }, { status: 400 });
    filters.push(sc.sql);
    filterParams.push(sc.value);
  }
  const extra = filters.length ? ` AND ${filters.join(" AND ")}` : "";
  const voc = vocRaw ?? undefined; // echoed back when present
  const source = sourceRaw ?? undefined;

  // ?at= : nearest single reading to the given instant (matching the filters).
  const atRaw = url.searchParams.get("at");
  if (atRaw !== null) {
    const at = parseTime(atRaw);
    if (at === null) return Response.json({ error: `invalid 'at' time: ${atRaw}` }, { status: 400 });
    const row = await env.DB.prepare(
      `SELECT ${cols} FROM readings WHERE 1=1${extra} ORDER BY ABS(ts - ?) ASC LIMIT 1`,
    )
      .bind(...filterParams, at)
      .first<Record<string, unknown>>();
    return Response.json({ mode: "at", at, source, voc, count: row ? 1 : 0, readings: decorateTimes(row ? [row] : []) });
  }

  // ?from= / ?to= : explicit range (either bound may be omitted).
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  if (fromRaw !== null || toRaw !== null) {
    const from = fromRaw !== null ? parseTime(fromRaw) : -Infinity;
    const to = toRaw !== null ? parseTime(toRaw) : Infinity;
    if (from === null) return Response.json({ error: `invalid 'from' time: ${fromRaw}` }, { status: 400 });
    if (to === null) return Response.json({ error: `invalid 'to' time: ${toRaw}` }, { status: 400 });
    const lo = from === -Infinity ? 0 : from;
    const hi = to === Infinity ? Number.MAX_SAFE_INTEGER : to;
    const { results } = await env.DB.prepare(
      `SELECT ${cols} FROM readings WHERE ts >= ? AND ts <= ?${extra} ORDER BY ts ASC`,
    )
      .bind(lo, hi, ...filterParams)
      .all<Record<string, unknown>>();
    return Response.json({ mode: "range", from: lo, to: hi, source, voc, count: results.length, readings: decorateTimes(results) });
  }

  // ?hours= : relative window (default 72, capped at retention).
  const cap = numOrDefault(env.RETENTION_HOURS, 72);
  const arg = parseInt(url.searchParams.get("hours") ?? "", 10);
  const hours = Math.min(Number.isFinite(arg) && arg > 0 ? arg : 72, cap);
  const since = Date.now() - hoursToMs(hours);

  const { results } = await env.DB.prepare(
    `SELECT ${cols} FROM readings WHERE ts >= ?${extra} ORDER BY ts ASC`,
  )
    .bind(since, ...filterParams)
    .all<Record<string, unknown>>();

  return Response.json({ mode: "hours", hours, source, voc, count: results.length, readings: decorateTimes(results) });
}

/** Parse a "?voc=" filter like "<40", "<=40", ">40", ">=40", "=40", or "40" (equal) into a SQL fragment + value; null if invalid. */
function parseVoc(raw: string): { sql: string; value: number } | null {
  const m = raw.trim().match(/^(<=|>=|<|>|=)?\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const op = m[1] === "=" || m[1] === undefined ? "=" : m[1];
  return { sql: `voc_index ${op} ?`, value: Number(m[2]) };
}

/**
 * Add a human-readable `time` field (ISO-8601 with Stockholm offset, e.g.
 * "2026-06-05T07:30:00+02:00") next to each row's epoch-ms `ts`. One formatter
 * is built per call and reused across all rows.
 */
function decorateTimes(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Stockholm",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  });
  // voc_index leads each row (right after source, before the long ISO `time`
  // string) so it's visible in Firefox's collapsed-object preview.
  return rows.map(({ source, ts, voc_index, ...rest }) => ({
    source,
    voc_index,
    ts,
    time: isoLocal(ts as number, fmt),
    ...rest,
  }));
}

/** Format epoch ms as ISO-8601 with the zone's offset, using a prepared Stockholm formatter. */
function isoLocal(ms: number, fmt: Intl.DateTimeFormat): string {
  const m: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) m[p.type] = p.value;
  const off = m.timeZoneName.replace(/^GMT/, "") || "+00:00"; // "GMT+02:00" -> "+02:00"
  return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}:${m.second}${off}`;
}

/** Parse an ISO timestamp (e.g. "2026-06-05T14:30:00+02:00") or bare epoch ms to epoch ms; null if invalid. */
function parseTime(raw: string): number | null {
  let s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s); // already epoch ms
  // A literal '+' in a query value is form-decoded to a space, so the offset
  // "...T07:30:00+02:00" arrives as "...T07:30:00 02:00". Restore the '+'.
  s = s.replace(/ (\d{2}:?\d{2})$/, "+$1");
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Sensor + Telegram I/O
// ---------------------------------------------------------------------------

async function fetchReading(source: Source): Promise<Reading> {
  const base = source.url.replace(/\/+$/, "");
  const res = await fetch(`${base}/json`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sensor returned HTTP ${res.status}`);

  // Sensors disagree on field names/coverage; read as a loose record and map.
  const d = (await res.json()) as Record<string, unknown>;

  const numN = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const bool = (v: unknown): boolean => v === true;
  // Nullable boolean: preserves NULL for sensors that omit the field.
  const boolN = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

  // voc_index is the primary metric, required from every sensor.
  if (typeof d.voc_index !== "number") throw new Error("missing 'voc_index' in sensor JSON");

  return {
    source: source.id,
    voc_index: d.voc_index,
    temperature_c: numN(d.temp_c),
    humidity_pct: numN(d.rh_pct),
    label: typeof d.label === "string" ? d.label : typeof d.status === "string" ? d.status : "",
    warmup: bool(d.warmup),

    alarm: boolN(d.alarm),
    alarm_state: typeof d.alarm_state === "string" ? d.alarm_state : null,
    event_count: numN(d.event_count),
    last_event_s: numN(d.last_event_s),
    uptime_s: numN(d.uptime_s),
    sht_ok: boolN(d.sht_ok),

    voc_fast: numN(d.voc_fast),
    voc_slow: numN(d.voc_slow),
    voc_baseline: numN(d.voc_baseline),
    voc_jump_pct: numN(d.voc_jump_pct),
    voc_avg_5min: numN(d.voc_avg_5min),
    voc_delta: numN(d.voc_delta),
    voc_raw: numN(d.voc_raw),

    mq135_raw: numN(d.mq135_raw),
    mq135_fast: numN(d.mq135_fast),
    mq135_slow: numN(d.mq135_slow),
    mq135_baseline: numN(d.mq135_baseline),
    mq135_jump_pct: numN(d.mq135_jump_pct),

    toilet_score: numN(d.toilet_score),
    // The rich firmware calls this "alcohol"; keep the historical ipa_* column.
    ipa_score: numN(d.ipa_score) ?? numN(d.alcohol_score),

    baseline_ready: bool(d.baseline_ready),
    seeding: bool(d.seeding),
    toilet_like: bool(d.toilet_like),
    ipa_like: bool(d.ipa_like) || bool(d.alcohol_like),
    suppressed: bool(d.suppressed),
    needs_cleaning: bool(d.needs_cleaning),
  };
}

async function sendTelegram(env: Env, chatId: number | string, text: string): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    },
  );
  if (!res.ok) {
    console.error("telegram send failed:", res.status, await res.text().catch(() => ""));
  }
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function getStateValue(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM state WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row ? row.value : null;
}

async function setStateValue(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, value)
    .run();
}

async function getArmed(env: Env, key: string): Promise<boolean> {
  return (await getStateValue(env, key)) !== "0"; // default armed
}

async function setArmed(env: Env, armed: boolean, key: string): Promise<void> {
  await setStateValue(env, key, armed ? "1" : "0");
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function numOrDefault(s: string | undefined, fallback: number): number {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : fallback;
}

function hoursToMs(h: number): number {
  return h * 60 * 60 * 1000;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Like fmt(), but renders a missing (null) value as "—". */
function fmtN(n: number | null): string {
  return n === null ? "—" : fmt(n);
}

/** Escape a string for Telegram HTML parse_mode (sensor `label` can contain &, <, >). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function localFromMs(ms: number): string {
  // Wall-clock time in Sweden; Intl handles the CET/CEST (DST) switch automatically.
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(ms));
}

function nowLocal(): string {
  return localFromMs(Date.now());
}

function fmtDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Minimal Telegram types (only what we read)
// ---------------------------------------------------------------------------

interface TelegramUpdate {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
interface TelegramMessage {
  text?: string;
  chat?: { id: number };
}
