-- Migration: single-sensor -> multi-sensor.
-- Adds the `source` column (existing rows become source 'fozzie', the original
-- rapevan sensor), the new
-- normalized `event` column, and the simple-sensor VOC extras; moves the PK to
-- (source, ts). SQLite can't ALTER a PK, so we rebuild the table and copy.
--
-- Apply with:
--   wrangler d1 execute poop-detector --remote --file=./migrations/0001_multi_source.sql
-- (use --local for the local dev db). Back up first if the data matters.

PRAGMA foreign_keys=OFF;

ALTER TABLE readings RENAME TO readings_old;

CREATE TABLE readings (
  source         TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  voc_index      INTEGER NOT NULL,
  temperature_c  REAL,
  humidity_pct   REAL,
  label          TEXT,
  event          INTEGER,

  voc_fast       REAL,
  voc_slow       REAL,
  voc_baseline   REAL,
  voc_jump_pct   REAL,
  voc_avg_5min   REAL,
  voc_delta      REAL,
  voc_raw        INTEGER,

  mq135_raw      INTEGER,
  mq135_fast     REAL,
  mq135_slow     REAL,
  mq135_baseline REAL,
  mq135_jump_pct REAL,

  toilet_score   REAL,
  ipa_score      REAL,

  baseline_ready INTEGER,
  seeding        INTEGER,
  toilet_like    INTEGER,
  ipa_like       INTEGER,
  suppressed     INTEGER,
  needs_cleaning INTEGER,

  PRIMARY KEY (source, ts)
);

-- Copy existing rows, tagging them as the original 'fozzie' sensor and deriving
-- the normalized `event` flag from the old `toilet_like` column.
INSERT INTO readings (
  source, ts, voc_index, temperature_c, humidity_pct, label, event,
  voc_fast, voc_slow, voc_baseline, voc_jump_pct,
  mq135_raw, mq135_fast, mq135_slow, mq135_baseline, mq135_jump_pct,
  toilet_score, ipa_score,
  baseline_ready, seeding, toilet_like, ipa_like, suppressed, needs_cleaning
)
SELECT
  'fozzie', ts, voc_index, temperature_c, humidity_pct, label, toilet_like,
  voc_fast, voc_slow, voc_baseline, voc_jump_pct,
  mq135_raw, mq135_fast, mq135_slow, mq135_baseline, mq135_jump_pct,
  toilet_score, ipa_score,
  baseline_ready, seeding, toilet_like, ipa_like, suppressed, needs_cleaning
FROM readings_old;

DROP TABLE readings_old;

CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts);

-- Carry the old alert state over to the per-source keys for 'fozzie'.
INSERT INTO state (key, value)
  SELECT 'toilet_armed:fozzie', value FROM state WHERE key = 'toilet_armed'
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
INSERT INTO state (key, value)
  SELECT 'last_incident_ts:fozzie', value FROM state WHERE key = 'last_incident_ts'
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

PRAGMA foreign_keys=ON;
