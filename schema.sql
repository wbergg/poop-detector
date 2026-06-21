-- poop-detector D1 schema
-- Time-series readings. ts (epoch ms) is the PK, so it's already indexed for range/rotation queries.
CREATE TABLE IF NOT EXISTS readings (
  ts             INTEGER PRIMARY KEY,  -- epoch milliseconds
  voc_index      INTEGER NOT NULL,     -- primary metric (baseline ~92-100, drops on events)
  temperature_c  REAL,                 -- sensor field temp_c
  humidity_pct   REAL,                 -- sensor field rh_pct
  label          TEXT,

  -- VOC pipeline (raw index + EMA fast/slow, drifting baseline, jump %)
  voc_fast       REAL,
  voc_slow       REAL,
  voc_baseline   REAL,
  voc_jump_pct   REAL,

  -- MQ-135 gas sensor (raw ADC + EMA fast/slow, drifting baseline, jump %)
  mq135_raw      INTEGER,
  mq135_fast     REAL,
  mq135_slow     REAL,
  mq135_baseline REAL,
  mq135_jump_pct REAL,

  -- Derived event scores
  toilet_score   REAL,
  ipa_score      REAL,

  -- Boolean flags (stored as 0/1)
  baseline_ready INTEGER,
  seeding        INTEGER,
  toilet_like    INTEGER,
  ipa_like       INTEGER,
  suppressed     INTEGER,
  needs_cleaning INTEGER
);

-- Tiny key/value table for the alert state machine (and any future flags).
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Start "armed" so the first below-threshold reading fires an alert.
INSERT INTO state (key, value) VALUES ('armed', '1')
  ON CONFLICT(key) DO NOTHING;
