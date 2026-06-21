/**
 * poop-detector — Cloudflare Worker
 *
 * - scheduled() runs every minute: fetches the sensor's /json, stores the reading
 *   in D1, runs the threshold alert state machine, and rotates out old rows.
 * - fetch() serves the Telegram webhook (/poop, /stats) and a token-protected
 *   /history JSON endpoint.
 */

export interface Env {
  DB: D1Database;
  // secrets
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ALERT_CHAT_ID: string;
  // vars (arrive as strings)
  SOURCE_URL: string;
  THRESHOLD: string;
  REARM_MARGIN: string;
  RETENTION_HOURS: string;
}

interface Reading {
  voc_index: number;
  temperature_c: number;
  humidity_pct: number;
  label: string;
  warmup: boolean;

  // VOC pipeline
  voc_fast: number;
  voc_slow: number;
  voc_baseline: number;
  voc_jump_pct: number;

  // MQ-135 gas sensor
  mq135_raw: number;
  mq135_fast: number;
  mq135_slow: number;
  mq135_baseline: number;
  mq135_jump_pct: number;

  // Derived event scores
  toilet_score: number;
  ipa_score: number;

  // Boolean flags
  baseline_ready: boolean;
  seeding: boolean;
  toilet_like: boolean;
  ipa_like: boolean;
  suppressed: boolean;
  needs_cleaning: boolean;
}

const FETCH_TIMEOUT_MS = 10_000;

// Fallback used only if env.THRESHOLD is unset; the deployed value lives in wrangler.jsonc.
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
// Cron: scrape -> store -> alert -> rotate
// ---------------------------------------------------------------------------

async function tick(env: Env): Promise<void> {
  let reading: Reading;
  try {
    reading = await fetchReading(env);
  } catch (err) {
    // Skip + log silently (per design): a failed scrape writes nothing, no alert.
    console.error("scrape failed:", err instanceof Error ? err.message : err);
    return;
  }

  if (reading.warmup) {
    console.log("sensor warming up, skipping reading");
    return;
  }

  const ts = Date.now();

  const b01 = (v: boolean): number => (v ? 1 : 0);

  await env.DB.prepare(
    `INSERT INTO readings (
       ts, voc_index, temperature_c, humidity_pct, label,
       voc_fast, voc_slow, voc_baseline, voc_jump_pct,
       mq135_raw, mq135_fast, mq135_slow, mq135_baseline, mq135_jump_pct,
       toilet_score, ipa_score,
       baseline_ready, seeding, toilet_like, ipa_like, suppressed, needs_cleaning
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ts, reading.voc_index, reading.temperature_c, reading.humidity_pct, reading.label,
      reading.voc_fast, reading.voc_slow, reading.voc_baseline, reading.voc_jump_pct,
      reading.mq135_raw, reading.mq135_fast, reading.mq135_slow, reading.mq135_baseline, reading.mq135_jump_pct,
      reading.toilet_score, reading.ipa_score,
      b01(reading.baseline_ready), b01(reading.seeding), b01(reading.toilet_like),
      b01(reading.ipa_like), b01(reading.suppressed), b01(reading.needs_cleaning),
    )
    .run();

  // VOC-threshold alerting is disabled for now; only fire on toilet_like events.
  await evaluateToiletAlert(env, reading, ts);

  // Inline rotation: drop anything older than the retention window.
  const cutoff = ts - hoursToMs(numOrDefault(env.RETENTION_HOURS, 72));
  await env.DB.prepare(`DELETE FROM readings WHERE ts < ?`).bind(cutoff).run();
}

/**
 * Edge-trigger toilet alert: one Telegram message when the sensor's `toilet_like`
 * flag turns on, then silent until it clears and re-arms. Tracked under its own
 * `toilet_armed` state key, independent of the VOC threshold alert above.
 */
async function evaluateToiletAlert(env: Env, reading: Reading, ts: number): Promise<void> {
  const armed = await getArmed(env, "toilet_armed");

  if (armed && reading.toilet_like) {
    await sendTelegram(env, env.ALERT_CHAT_ID, toiletAlertMessage(reading));
    await setArmed(env, false, "toilet_armed");
    // Stamp the incident for /streak (survives the 72h rotation); reuse the
    // reading's own ts so the stamp matches the row that fired it.
    await setStateValue(env, "last_incident_ts", String(ts));
  } else if (!armed && !reading.toilet_like) {
    // Flag cleared: re-arm silently for the next event.
    await setArmed(env, true, "toilet_armed");
  }
}

/** The toilet-alert message body, shared by the live alert and the /testalert self-test. */
function toiletAlertMessage(r: Reading): string {
  return `🚽💩 <b>Toilet activity detected!</b>\nVOC ${fmt(r.voc_index)} — ${esc(r.label)}.`;
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

  // "/poop@MyBot extra" -> "/poop"
  const cmd = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  if (cmd === "/poop") {
    await replyPoop(env, chatId);
  } else if (cmd === "/stats") {
    await replyStats(env, chatId, text);
  } else if (cmd === "/status") {
    await replyStatus(env, chatId);
  } else if (cmd === "/threshold") {
    await replyThreshold(env, chatId);
  } else if (cmd === "/safe") {
    await replySafe(env, chatId);
  } else if (cmd === "/streak") {
    await replyStreak(env, chatId);
  } else if (cmd === "/chart") {
    await replyChart(env, chatId, text);
  } else if (cmd === "/testalert") {
    await replyTestAlert(env, chatId);
  } else if (cmd === "/help" || cmd === "/start") {
    await replyHelp(env, chatId);
  }

  return new Response("ok\n");
}

/** /poop: live fetch right now and report the fresh reading. */
async function replyPoop(env: Env, chatId: number): Promise<void> {
  try {
    const r = await fetchReading(env);
    if (r.warmup) {
      // No valid reading during warmup — acknowledge without posting a value.
      await sendTelegram(env, chatId, "⚠️ ⏳ Sensor is warming up, no valid reading yet. ⚠️");
      return;
    }
    const threshold = numOrDefault(env.THRESHOLD, DEFAULT_THRESHOLD);
    const emoji = r.voc_index >= threshold ? "✅" : "💩";
    const lines = [
      `${emoji} <b>VOC: ${fmt(r.voc_index)}</b> (${esc(r.label)})`,
      `Temp: ${fmt(r.temperature_c)}°C · Humidity: ${fmt(r.humidity_pct)}%`,
      `🕒 ${nowLocal()}`,
    ];
    await sendTelegram(env, chatId, lines.join("\n"));
  } catch {
    await sendTelegram(env, chatId, "⚠️ Couldn't reach the sensor right now.");
  }
}

/** /stats [hours]: min/max/avg + trend over the window (default 72h, capped at retention). */
async function replyStats(env: Env, chatId: number, text: string): Promise<void> {
  const cap = numOrDefault(env.RETENTION_HOURS, 72);
  const arg = parseInt(text.trim().split(/\s+/)[1] ?? "", 10);
  const hours = Math.min(Number.isFinite(arg) && arg > 0 ? arg : 72, cap);
  const since = Date.now() - hoursToMs(hours);

  // One round-trip: aggregates + the window's first/last voc_index (trend endpoints
  // scoped to the same window, ordered ASC so MIN/MAX-by-ts pick the edges).
  const [agg, firstRow, lastRow] = await env.DB.batch<{ voc_index: number } & {
    n: number; mn: number | null; mx: number | null; av: number | null;
  }>([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(voc_index) AS mn, MAX(voc_index) AS mx, AVG(voc_index) AS av
       FROM readings WHERE ts >= ?`,
    ).bind(since),
    env.DB.prepare(`SELECT voc_index FROM readings WHERE ts >= ? ORDER BY ts ASC LIMIT 1`).bind(since),
    env.DB.prepare(`SELECT voc_index FROM readings WHERE ts >= ? ORDER BY ts DESC LIMIT 1`).bind(since),
  ]).then((rs) => rs.map((r) => r.results[0]));

  if (!agg || agg.n === 0) {
    await sendTelegram(env, chatId, `📊 No data yet for the last ${hours}h.`);
    return;
  }

  const delta = (lastRow?.voc_index ?? 0) - (firstRow?.voc_index ?? 0);
  const arrow = delta > 1 ? "📈" : delta < -1 ? "📉" : "➡️";

  const msg = [
    `📊 <b>Last ${hours}h</b> (${agg.n} readings)`,
    `VOC — min ${fmt(agg.mn!)} · avg ${fmt(agg.av!)} · max ${fmt(agg.mx!)}`,
    `Trend ${arrow} ${fmt(firstRow?.voc_index ?? 0)} → ${fmt(lastRow?.voc_index ?? 0)} (${delta >= 0 ? "+" : ""}${fmt(delta)})`,
  ].join("\n");

  await sendTelegram(env, chatId, msg);
}

/** /status: last reading, age, stored count, and current alert state. */
async function replyStatus(env: Env, chatId: number): Promise<void> {
  const last = await env.DB.prepare(
    `SELECT ts, voc_index, label FROM readings ORDER BY ts DESC LIMIT 1`,
  ).first<{ ts: number; voc_index: number; label: string }>();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM readings`).first<{ n: number }>();
  const armed = await getArmed(env);
  const threshold = numOrDefault(env.THRESHOLD, DEFAULT_THRESHOLD);
  const margin = numOrDefault(env.REARM_MARGIN, 0);

  if (!last) {
    await sendTelegram(env, chatId, "📟 <b>Status</b>\nNo readings stored yet.");
    return;
  }

  const ageMin = Math.round((Date.now() - last.ts) / 60_000);
  const msg = [
    "📟 <b>Status</b>",
    `Last reading: <b>${fmt(last.voc_index)}</b> (${esc(last.label)}) — ${ageMin}m ago`,
    `Stored readings: ${total?.n ?? 0}`,
    `Alerts: ${armed ? "armed ✅" : "fired — waiting for recovery 🔕"}`,
    `Threshold: ${fmt(threshold)} (re-arm ≥ ${fmt(threshold + margin)})`,
  ].join("\n");
  await sendTelegram(env, chatId, msg);
}

/** /threshold: report the current alert threshold and re-arm point. */
async function replyThreshold(env: Env, chatId: number): Promise<void> {
  const threshold = numOrDefault(env.THRESHOLD, DEFAULT_THRESHOLD);
  const margin = numOrDefault(env.REARM_MARGIN, 0);
  const msg =
    `🎚️ Threshold: <b>${fmt(threshold)}</b>\n` +
    `Alert when VOC &lt; ${fmt(threshold)}; re-arm when VOC ≥ ${fmt(threshold + margin)} (margin ${fmt(margin)}).`;
  await sendTelegram(env, chatId, msg);
}

/** /safe: live "can I go in?" verdict from the current VOC. */
async function replySafe(env: Env, chatId: number): Promise<void> {
  try {
    const r = await fetchReading(env);
    if (r.warmup) {
      await sendTelegram(env, chatId, "⚠️ ⏳ Sensor warming up — can't call it yet. ⚠️");
      return;
    }
    const threshold = numOrDefault(env.THRESHOLD, DEFAULT_THRESHOLD);
    let verdict: string;
    if (r.voc_index < threshold) verdict = "🔴 <b>NOPE</b> — abort mission";
    else if (r.voc_index < threshold + 15) verdict = "🟡 <b>IFFY</b> — enter with caution";
    else verdict = "🟢 <b>SAFE</b> — all clear";
    await sendTelegram(env, chatId, `${verdict}\nVOC ${fmt(r.voc_index)} (${esc(r.label)})`);
  } catch {
    await sendTelegram(env, chatId, "⚠️ Couldn't reach the sensor right now.");
  }
}

/** /streak: time since the last alert event (persisted across rotation). */
async function replyStreak(env: Env, chatId: number): Promise<void> {
  const tsStr = await getStateValue(env, "last_incident_ts");
  if (!tsStr) {
    await sendTelegram(env, chatId, "🏆 No incidents on record — spotless streak! 🎉");
    return;
  }
  const elapsed = Date.now() - Number(tsStr);
  await sendTelegram(
    env,
    chatId,
    `🏆 <b>${fmtDuration(elapsed)}</b> since the last incident.\n(last dip below ${fmt(numOrDefault(env.THRESHOLD, DEFAULT_THRESHOLD))} at ${localFromMs(Number(tsStr))})`,
  );
}

/** /chart [hours]: ASCII sparkline of VOC over the window (default 72h). */
async function replyChart(env: Env, chatId: number, text: string): Promise<void> {
  const cap = numOrDefault(env.RETENTION_HOURS, 72);
  const arg = parseInt(text.trim().split(/\s+/)[1] ?? "", 10);
  const hours = Math.min(Number.isFinite(arg) && arg > 0 ? arg : 72, cap);
  const since = Date.now() - hoursToMs(hours);

  const { results } = await env.DB.prepare(
    `SELECT ts, voc_index FROM readings WHERE ts >= ? ORDER BY ts ASC`,
  )
    .bind(since)
    .all<{ ts: number; voc_index: number }>();

  if (results.length === 0) {
    await sendTelegram(env, chatId, `📈 No data yet for the last ${hours}h.`);
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
    `📈 <b>VOC · last ${hours}h</b>\n` +
    `<pre>${spark}</pre>` +
    `min ${fmt(min)} · max ${fmt(max)} · now ${fmt(last)}`;
  await sendTelegram(env, chatId, msg);
}

/**
 * /testalert: safe self-test — sends the toilet-alert message to whoever ran the
 * command (so DM the bot to get it privately), never to the group ALERT_CHAT_ID.
 * Uses the live reading so the formatting matches a real alert exactly.
 */
async function replyTestAlert(env: Env, chatId: number): Promise<void> {
  try {
    const r = await fetchReading(env);
    await sendTelegram(
      env,
      chatId,
      `🧪 <i>Test — this is exactly what a toilet alert looks like (current live values):</i>\n\n${toiletAlertMessage(r)}`,
    );
  } catch {
    await sendTelegram(env, chatId, "⚠️ Couldn't reach the sensor for the test.");
  }
}

/** /help (and /start): list the available commands. */
async function replyHelp(env: Env, chatId: number): Promise<void> {
  const msg = [
    "💩 <b>poop-detector</b>",
    "/poop — live sensor reading",
    "/safe — can I go in right now?",
    "/stats [hours] — min/avg/max + trend (default 72)",
    "/chart [hours] — sparkline of VOC (default 72)",
    "/streak — time since the last incident",
    "/status — last reading, count, alert state",
    "/threshold — current alert threshold",
    "/help — this message",
  ].join("\n");
  await sendTelegram(env, chatId, msg);
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
  // Any mode can be combined with ?voc=<op><n> (e.g. <40, >=40, =40) to filter by voc_index.
  const cols =
    `ts, voc_index, temperature_c, humidity_pct, label, ` +
    `voc_fast, voc_slow, voc_baseline, voc_jump_pct, ` +
    `mq135_raw, mq135_fast, mq135_slow, mq135_baseline, mq135_jump_pct, ` +
    `toilet_score, ipa_score, ` +
    `baseline_ready, seeding, toilet_like, ipa_like, suppressed, needs_cleaning`;

  // Optional voc_index filter, applied on top of whichever time mode runs below.
  const vocRaw = url.searchParams.get("voc");
  let vocSql = "";
  const vocParams: number[] = [];
  if (vocRaw !== null) {
    const sc = parseVoc(vocRaw);
    if (sc === null) return Response.json({ error: `invalid 'voc' filter: ${vocRaw}` }, { status: 400 });
    vocSql = ` AND ${sc.sql}`;
    vocParams.push(sc.value);
  }
  const filter = vocRaw ?? undefined; // echoed back when present

  // ?at= : nearest single reading to the given instant (matching the voc filter).
  const atRaw = url.searchParams.get("at");
  if (atRaw !== null) {
    const at = parseTime(atRaw);
    if (at === null) return Response.json({ error: `invalid 'at' time: ${atRaw}` }, { status: 400 });
    const row = await env.DB.prepare(
      `SELECT ${cols} FROM readings WHERE 1=1${vocSql} ORDER BY ABS(ts - ?) ASC LIMIT 1`,
    )
      .bind(...vocParams, at)
      .first<Record<string, unknown>>();
    return Response.json({ mode: "at", at, voc: filter, count: row ? 1 : 0, readings: decorateTimes(row ? [row] : []) });
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
      `SELECT ${cols} FROM readings WHERE ts >= ? AND ts <= ?${vocSql} ORDER BY ts ASC`,
    )
      .bind(lo, hi, ...vocParams)
      .all<Record<string, unknown>>();
    return Response.json({ mode: "range", from: lo, to: hi, voc: filter, count: results.length, readings: decorateTimes(results) });
  }

  // ?hours= : relative window (default 72, capped at retention).
  const cap = numOrDefault(env.RETENTION_HOURS, 72);
  const arg = parseInt(url.searchParams.get("hours") ?? "", 10);
  const hours = Math.min(Number.isFinite(arg) && arg > 0 ? arg : 72, cap);
  const since = Date.now() - hoursToMs(hours);

  const { results } = await env.DB.prepare(
    `SELECT ${cols} FROM readings WHERE ts >= ?${vocSql} ORDER BY ts ASC`,
  )
    .bind(since, ...vocParams)
    .all<Record<string, unknown>>();

  return Response.json({ mode: "hours", hours, voc: filter, count: results.length, readings: decorateTimes(results) });
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
  return rows.map(({ ts, ...rest }) => ({ ts, time: isoLocal(ts as number, fmt), ...rest }));
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

async function fetchReading(env: Env): Promise<Reading> {
  const base = env.SOURCE_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/json`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sensor returned HTTP ${res.status}`);

  // The sensor JSON uses temp_c/rh_pct (not temperature_c/humidity_pct), so read
  // it as a loose record and map field names explicitly.
  const d = (await res.json()) as Record<string, unknown>;

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const bool = (v: unknown): boolean => v === true;

  // voc_index is the primary metric (baseline ~92-100, drops during events).
  if (typeof d.voc_index !== "number") throw new Error("missing 'voc_index' in sensor JSON");

  return {
    voc_index: d.voc_index,
    temperature_c: num(d.temp_c),
    humidity_pct: num(d.rh_pct),
    label: typeof d.label === "string" ? d.label : typeof d.status === "string" ? d.status : "",
    warmup: bool(d.warmup),

    voc_fast: num(d.voc_fast),
    voc_slow: num(d.voc_slow),
    voc_baseline: num(d.voc_baseline),
    voc_jump_pct: num(d.voc_jump_pct),

    mq135_raw: num(d.mq135_raw),
    mq135_fast: num(d.mq135_fast),
    mq135_slow: num(d.mq135_slow),
    mq135_baseline: num(d.mq135_baseline),
    mq135_jump_pct: num(d.mq135_jump_pct),

    toilet_score: num(d.toilet_score),
    ipa_score: num(d.ipa_score),

    baseline_ready: bool(d.baseline_ready),
    seeding: bool(d.seeding),
    toilet_like: bool(d.toilet_like),
    ipa_like: bool(d.ipa_like),
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

async function getArmed(env: Env, key = "armed"): Promise<boolean> {
  return (await getStateValue(env, key)) !== "0"; // default armed
}

async function setArmed(env: Env, armed: boolean, key = "armed"): Promise<void> {
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
