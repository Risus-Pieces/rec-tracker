-- Rec Tracker schema. Safe to run repeatedly: every statement is idempotent.

-- One row holding the live count and the settings that go with it.
CREATE TABLE IF NOT EXISTS state (
  id            int PRIMARY KEY CHECK (id = 1),
  occupancy     int NOT NULL DEFAULT 0 CHECK (occupancy >= 0),
  peak          int NOT NULL DEFAULT 0,
  peak_at       timestamptz,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  last_reset_at timestamptz NOT NULL DEFAULT now(),
  -- The count goes back to 0 once a day at this local time.
  reset_time    time NOT NULL DEFAULT '00:00',
  timezone      text NOT NULL DEFAULT 'America/Chicago',
  -- While the admin page is open, devices are asked to check in faster.
  fast_until    timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per sensor unit. The role decides whether its counts add or subtract.
CREATE TABLE IF NOT EXISTS devices (
  id              serial PRIMARY KEY,
  name            text NOT NULL,
  role            text NOT NULL CHECK (role IN ('entrance', 'exit')),
  token_hash      text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Counting state: the device reports a running total since it booted, and
  -- the server adds only the difference from the last total it saw.
  boot_id         text,
  boot_total      bigint NOT NULL DEFAULT 0,
  -- Health, overwritten on every check-in.
  last_seen_at    timestamptz,
  local_count     bigint,
  distance_mm     int,
  baseline_mm     int,
  threshold_mm    int,
  present         boolean,
  readings_per_sec int,
  sensor_ok       boolean,
  sensor_status   text,
  sensor_restarts bigint,
  uptime_s        bigint,
  rssi            int,
  firmware        text
);

-- How busy counts as busy, for the label on the public page. Set on the admin page.
ALTER TABLE state ADD COLUMN IF NOT EXISTS quiet_below int NOT NULL DEFAULT 50;
ALTER TABLE state ADD COLUMN IF NOT EXISTS busy_from int NOT NULL DEFAULT 120;

-- Added in firmware 2.1: enough to tell why a unit dropped off.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS checkin_failures bigint;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_error int;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reset_reason text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS free_heap int;

-- Commands wait here until the device's next check-in picks them up.
CREATE TABLE IF NOT EXISTS commands (
  id           bigserial PRIMARY KEY,
  device_id    int NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('reset', 'calibrate')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS commands_pending_idx ON commands (device_id, id) WHERE completed_at IS NULL;

-- Every change to the count, for the admin activity list.
CREATE TABLE IF NOT EXISTS events (
  id              bigserial PRIMARY KEY,
  device_id       int REFERENCES devices (id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('count', 'reset', 'nightly_reset', 'adjust')),
  delta           int NOT NULL,
  occupancy_after int NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at DESC);
