-- Migration: simple-sensor firmware update.
-- The newer firmware dropped the transient `event` flag and now exposes a
-- sustained `alarm` output plus some diagnostics (alarm_state, event_count,
-- last_event_s, uptime_s, sht_ok). The alert now fires on `alarm` (falling back
-- to the rich sensor's `toilet_like`), so the normalized `event` column is gone.
--
-- Apply with:
--   wrangler d1 execute poop-detector --remote --file=./migrations/0002_alarm_fields.sql
-- (use --local for the local dev db). Back up first if the data matters.

ALTER TABLE readings ADD COLUMN alarm INTEGER;
ALTER TABLE readings ADD COLUMN alarm_state TEXT;
ALTER TABLE readings ADD COLUMN event_count INTEGER;
ALTER TABLE readings ADD COLUMN last_event_s INTEGER;
ALTER TABLE readings ADD COLUMN uptime_s INTEGER;
ALTER TABLE readings ADD COLUMN sht_ok INTEGER;

-- The transient `event` flag is no longer produced by any sensor; drop it.
-- (Rich-sensor detections are still recorded in the `toilet_like` column.)
ALTER TABLE readings DROP COLUMN event;
