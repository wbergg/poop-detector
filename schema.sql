-- poop-detector D1 schema (multi-sensor)
-- Time-series readings, one row per sensor per scrape. The (source, ts) pair is
-- the PK, so per-source range/rotation queries are already indexed.
CREATE TABLE IF NOT EXISTS readings (
  source         TEXT NOT NULL,        -- sensor id (from the SOURCES config)
  ts             INTEGER NOT NULL,     -- epoch milliseconds
  voc_index      INTEGER NOT NULL,     -- primary metric (present on every sensor)
  temperature_c  REAL,                 -- sensor field temp_c
  humidity_pct   REAL,                 -- sensor field rh_pct
  label          TEXT,

  -- Alarm / event tracking (simple sensor; NULL when the sensor omits them).
  -- `alarm` is the sustained alarm output and is what the alert fires on.
  alarm          INTEGER,              -- sensor alarm output, 0/1
  alarm_state    TEXT,                 -- alarm state-machine label (e.g. warmup/idle/alarm)
  event_count    INTEGER,              -- cumulative detection events since boot
  last_event_s   INTEGER,              -- seconds since the last event (-1 = none)
  uptime_s       INTEGER,              -- sensor uptime in seconds
  sht_ok         INTEGER,              -- SHT temp/humidity sensor health, 0/1

  -- VOC pipeline (rich sensor: raw index + EMA fast/slow, drifting baseline, jump %)
  voc_fast       REAL,
  voc_slow       REAL,
  voc_baseline   REAL,
  voc_jump_pct   REAL,
  -- VOC extras (simple sensor)
  voc_avg_5min   REAL,
  voc_delta      REAL,
  voc_raw        INTEGER,

  -- MQ-135 gas sensor (rich sensor: raw ADC + EMA fast/slow, drifting baseline, jump %)
  mq135_raw      INTEGER,
  mq135_fast     REAL,
  mq135_slow     REAL,
  mq135_baseline REAL,
  mq135_jump_pct REAL,

  -- Derived event scores (rich sensor)
  toilet_score   REAL,
  ipa_score      REAL,

  -- Boolean flags (stored as 0/1; rich sensor)
  baseline_ready INTEGER,
  seeding        INTEGER,
  toilet_like    INTEGER,
  ipa_like       INTEGER,
  suppressed     INTEGER,
  needs_cleaning INTEGER,

  PRIMARY KEY (source, ts)
);

-- Rotation deletes by ts across all sources, so index ts on its own too.
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts);

-- Tiny key/value table for the alert state machine (and any future flags).
-- Alert state is now per-source: keys 'toilet_armed:<id>' and 'last_incident_ts:<id>'
-- are created lazily by the Worker (armed-by-default), so no seed row is needed.
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
