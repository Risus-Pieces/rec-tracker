// Everything that reads or changes the count. Each function takes `now` so
// tests can pin the clock; in production it is always the current time.
import { createHash, randomBytes } from "node:crypto";
import { query } from "./db";

export type Role = "entrance" | "exit";
export type CommandType = "reset" | "calibrate";

// A device counts as online if it checked in within this long. Three missed
// heartbeats at the normal rate.
export const ONLINE_WINDOW_S = 45;
// Check-in rates the server asks devices for.
export const NORMAL_INTERVAL_MS = 15000;
export const FAST_INTERVAL_MS = 2000;
// How long an open admin page keeps devices on the fast rate.
const FAST_WINDOW_S = 20;
// A command the device hasn't picked up in this long is dropped, so a
// recalibration can't fire hours later when the lane may not be empty.
export const COMMAND_TTL_S = 90;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return "rt_" + randomBytes(24).toString("hex");
}

// ---------- Nightly reset ----------

// Zeroes the count if the daily reset time has passed since the last reset.
// Called at the start of every read and write, so it needs no scheduler.
export async function applyNightlyReset(now = new Date()): Promise<boolean> {
  const rows = await query<{ was: number }>(
    `WITH boundary AS (
       SELECT CASE
         WHEN ($1::timestamptz AT TIME ZONE timezone)::time >= reset_time
           THEN (($1::timestamptz AT TIME ZONE timezone)::date + reset_time) AT TIME ZONE timezone
         ELSE (($1::timestamptz AT TIME ZONE timezone)::date - 1 + reset_time) AT TIME ZONE timezone
       END AS at
       FROM state WHERE id = 1
     ),
     r AS (
       UPDATE state s
       SET occupancy = 0, peak = 0, peak_at = NULL, changed_at = $1, last_reset_at = $1
       FROM boundary b, (SELECT occupancy AS was FROM state WHERE id = 1) old
       WHERE s.id = 1 AND s.last_reset_at < b.at
       RETURNING old.was
     ),
     c AS (
       INSERT INTO commands (device_id, type, created_at)
       SELECT d.id, 'reset', $1 FROM devices d, r
     ),
     e AS (
       INSERT INTO events (kind, delta, occupancy_after, created_at)
       SELECT 'nightly_reset', -r.was, 0, $1 FROM r
     )
     SELECT was FROM r`,
    [now],
  );
  return rows.length > 0;
}

// ---------- Device check-in ----------

export interface CheckInReport {
  boot: string;
  total: number;
  count?: number | null;
  mm?: number | null;
  baseline?: number | null;
  threshold?: number | null;
  present?: boolean | null;
  rate?: number | null;
  sensorOk?: boolean | null;
  status?: string | null;
  restarts?: number | null;
  uptimeS?: number | null;
  rssi?: number | null;
  firmware?: string | null;
  // Reports that failed since the unit started, and the last failure's code.
  failures?: number | null;
  lastError?: number | null;
  // Why the unit last restarted.
  resetReason?: string | null;
  freeHeap?: number | null;
  // Highest command id the device has finished.
  ack?: number;
}

export interface CheckInResult {
  deviceId: number;
  delta: number;
  occupancy: number;
  intervalMs: number;
  commands: { id: number; type: CommandType }[];
}

// Records a device's report, applies any new counts to the occupancy, and
// returns the commands waiting for it. Returns null if the token is unknown.
export async function checkIn(token: string, report: CheckInReport, now = new Date()): Promise<CheckInResult | null> {
  await applyNightlyReset(now);
  const rows = await query<{
    device_id: number | null;
    delta: string | null;
    occupancy: number;
    fast: boolean;
    commands: { id: number; type: CommandType }[];
  }>(
    `WITH dev AS (
       SELECT id, role, boot_id, boot_total FROM devices WHERE token_hash = $1 FOR UPDATE
     ),
     calc AS (
       -- Same boot: count only what's new since the last report (a repeated
       -- or out-of-order report adds nothing). New boot: its total is all new.
       SELECT id, role,
         CASE WHEN boot_id IS NOT DISTINCT FROM $3 THEN GREATEST($4::bigint - boot_total, 0) ELSE $4::bigint END AS delta,
         CASE WHEN boot_id IS NOT DISTINCT FROM $3 THEN GREATEST($4::bigint, boot_total) ELSE $4::bigint END AS new_total
       FROM dev
     ),
     upd_dev AS (
       UPDATE devices d SET
         boot_id = $3, boot_total = c.new_total, last_seen_at = $2,
         local_count = $5, distance_mm = $6, baseline_mm = $7, threshold_mm = $8, present = $9,
         readings_per_sec = $10, sensor_ok = $11, sensor_status = $12, sensor_restarts = $13,
         uptime_s = $14, rssi = $15, firmware = $16,
         checkin_failures = $19, last_error = $20, reset_reason = $21, free_heap = $22
       FROM calc c WHERE d.id = c.id
     ),
     signed AS (
       SELECT id, (CASE role WHEN 'exit' THEN -delta ELSE delta END)::int AS change FROM calc WHERE delta > 0
     ),
     upd_state AS (
       UPDATE state s SET
         occupancy = GREATEST(0, s.occupancy + x.change),
         peak = GREATEST(s.peak, s.occupancy + x.change),
         peak_at = CASE WHEN s.occupancy + x.change > s.peak THEN $2 ELSE s.peak_at END,
         changed_at = $2
       FROM signed x WHERE s.id = 1
       RETURNING s.occupancy, x.change
     ),
     ev AS (
       INSERT INTO events (device_id, kind, delta, occupancy_after, created_at)
       SELECT x.id, 'count', u.change, u.occupancy, $2 FROM signed x, upd_state u
     ),
     acked AS (
       UPDATE commands SET completed_at = $2
       WHERE device_id = (SELECT id FROM dev) AND id <= $17 AND completed_at IS NULL
     ),
     cmds AS (
       UPDATE commands SET delivered_at = COALESCE(delivered_at, $2)
       WHERE device_id = (SELECT id FROM dev) AND id > $17 AND completed_at IS NULL
         AND created_at > $2::timestamptz - make_interval(secs => $18)
       RETURNING id, type
     )
     SELECT
       (SELECT id FROM calc) AS device_id,
       (SELECT delta FROM calc) AS delta,
       COALESCE((SELECT occupancy FROM upd_state), (SELECT occupancy FROM state WHERE id = 1)) AS occupancy,
       (SELECT fast_until > $2 FROM state WHERE id = 1) AS fast,
       COALESCE((SELECT json_agg(json_build_object('id', id, 'type', type) ORDER BY id) FROM cmds), '[]'::json) AS commands`,
    [
      hashToken(token),
      now,
      report.boot,
      report.total,
      report.count ?? null,
      report.mm ?? null,
      report.baseline ?? null,
      report.threshold ?? null,
      report.present ?? null,
      report.rate ?? null,
      report.sensorOk ?? null,
      report.status ?? null,
      report.restarts ?? null,
      report.uptimeS ?? null,
      report.rssi ?? null,
      report.firmware ?? null,
      report.ack ?? 0,
      COMMAND_TTL_S,
      report.failures ?? null,
      report.lastError ?? null,
      report.resetReason ?? null,
      report.freeHeap ?? null,
    ],
  );
  const row = rows[0];
  if (row.device_id === null) return null;
  return {
    deviceId: row.device_id,
    delta: Number(row.delta),
    occupancy: row.occupancy,
    intervalMs: row.fast ? FAST_INTERVAL_MS : NORMAL_INTERVAL_MS,
    commands: row.commands,
  };
}

// ---------- Public status ----------

export interface PublicStatus {
  occupancy: number;
  peak: number;
  peakAt: string | null;
  changedAt: string;
  sensors: { total: number; online: number };
  lastSeenAt: string | null;
  serverTime: string;
}

export async function getPublicStatus(now = new Date()): Promise<PublicStatus> {
  await applyNightlyReset(now);
  const [row] = await query<{
    occupancy: number;
    peak: number;
    peak_at: Date | null;
    changed_at: Date;
    total: number;
    online: number;
    last_seen_at: Date | null;
  }>(
    `SELECT s.occupancy, s.peak, s.peak_at, s.changed_at,
       (SELECT count(*)::int FROM devices) AS total,
       (SELECT count(*)::int FROM devices
         WHERE last_seen_at > $1::timestamptz - make_interval(secs => $2)) AS online,
       (SELECT max(last_seen_at) FROM devices) AS last_seen_at
     FROM state s WHERE s.id = 1`,
    [now, ONLINE_WINDOW_S],
  );
  return {
    occupancy: row.occupancy,
    peak: row.peak,
    peakAt: row.peak_at?.toISOString() ?? null,
    changedAt: row.changed_at.toISOString(),
    sensors: { total: row.total, online: row.online },
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    serverTime: now.toISOString(),
  };
}

// ---------- Admin ----------

export interface AdminDevice {
  id: number;
  name: string;
  role: Role;
  online: boolean;
  lastSeenAt: string | null;
  localCount: number | null;
  distanceMm: number | null;
  baselineMm: number | null;
  thresholdMm: number | null;
  present: boolean | null;
  readingsPerSec: number | null;
  sensorOk: boolean | null;
  sensorStatus: string | null;
  sensorRestarts: number | null;
  uptimeS: number | null;
  rssi: number | null;
  firmware: string | null;
  checkinFailures: number | null;
  lastError: number | null;
  resetReason: string | null;
  freeHeap: number | null;
  // The newest recalibrate request for this device, if any.
  calibration: { state: "waiting" | "running" | "done" | "expired"; at: string } | null;
}

export interface AdminEvent {
  id: number;
  kind: "count" | "reset" | "nightly_reset" | "adjust";
  device: string | null;
  delta: number;
  occupancyAfter: number;
  at: string;
}

export interface AdminStatus extends PublicStatus {
  resetTime: string;
  timezone: string;
  lastResetAt: string;
  devices: AdminDevice[];
  events: AdminEvent[];
}

const toNum = (v: string | number | null): number | null => (v === null ? null : Number(v));

// Full picture for the admin page. Reading it also keeps devices on the fast
// check-in rate, so live distance stays live while someone is watching.
export async function getAdminStatus(now = new Date()): Promise<AdminStatus> {
  const base = await getPublicStatus(now);
  const [settings] = await query<{ reset_time: string; timezone: string; last_reset_at: Date }>(
    `UPDATE state SET fast_until = $1::timestamptz + make_interval(secs => $2) WHERE id = 1
     RETURNING to_char(reset_time, 'HH24:MI') AS reset_time, timezone, last_reset_at`,
    [now, FAST_WINDOW_S],
  );
  const devices = await query<{
    id: number;
    name: string;
    role: Role;
    online: boolean;
    last_seen_at: Date | null;
    local_count: string | null;
    distance_mm: number | null;
    baseline_mm: number | null;
    threshold_mm: number | null;
    present: boolean | null;
    readings_per_sec: number | null;
    sensor_ok: boolean | null;
    sensor_status: string | null;
    sensor_restarts: string | null;
    uptime_s: string | null;
    rssi: number | null;
    firmware: string | null;
    checkin_failures: string | null;
    last_error: number | null;
    reset_reason: string | null;
    free_heap: number | null;
    cal_created: Date | null;
    cal_delivered: Date | null;
    cal_completed: Date | null;
  }>(
    `SELECT d.*,
       COALESCE(d.last_seen_at > $1::timestamptz - make_interval(secs => $2), false) AS online,
       c.created_at AS cal_created, c.delivered_at AS cal_delivered, c.completed_at AS cal_completed
     FROM devices d
     LEFT JOIN LATERAL (
       SELECT created_at, delivered_at, completed_at FROM commands
       WHERE device_id = d.id AND type = 'calibrate' ORDER BY id DESC LIMIT 1
     ) c ON true
     ORDER BY d.role, d.id`,
    [now, ONLINE_WINDOW_S],
  );
  const events = await query<{
    id: string;
    kind: AdminEvent["kind"];
    device: string | null;
    delta: number;
    occupancy_after: number;
    created_at: Date;
  }>(
    `SELECT e.id, e.kind, d.name AS device, e.delta, e.occupancy_after, e.created_at
     FROM events e LEFT JOIN devices d ON d.id = e.device_id
     ORDER BY e.id DESC LIMIT 20`,
  );
  return {
    ...base,
    resetTime: settings.reset_time,
    timezone: settings.timezone,
    lastResetAt: settings.last_reset_at.toISOString(),
    devices: devices.map((d) => {
      let calibration: AdminDevice["calibration"] = null;
      if (d.cal_created) {
        const expired = now.getTime() - d.cal_created.getTime() > COMMAND_TTL_S * 1000;
        if (d.cal_completed) calibration = { state: "done", at: d.cal_completed.toISOString() };
        else if (expired) calibration = { state: "expired", at: d.cal_created.toISOString() };
        else if (d.cal_delivered) calibration = { state: "running", at: d.cal_delivered.toISOString() };
        else calibration = { state: "waiting", at: d.cal_created.toISOString() };
      }
      return {
        id: d.id,
        name: d.name,
        role: d.role,
        online: d.online,
        lastSeenAt: d.last_seen_at?.toISOString() ?? null,
        localCount: toNum(d.local_count),
        distanceMm: d.distance_mm,
        baselineMm: d.baseline_mm,
        thresholdMm: d.threshold_mm,
        present: d.present,
        readingsPerSec: d.readings_per_sec,
        sensorOk: d.sensor_ok,
        sensorStatus: d.sensor_status,
        sensorRestarts: toNum(d.sensor_restarts),
        uptimeS: toNum(d.uptime_s),
        rssi: d.rssi,
        firmware: d.firmware,
        checkinFailures: toNum(d.checkin_failures),
        lastError: d.last_error,
        resetReason: d.reset_reason,
        freeHeap: d.free_heap,
        calibration,
      };
    }),
    events: events.map((e) => ({
      id: Number(e.id),
      kind: e.kind,
      device: e.device,
      delta: e.delta,
      occupancyAfter: e.occupancy_after,
      at: e.created_at.toISOString(),
    })),
  };
}

// Sets the count to 0 and tells every device to zero its own display too.
export async function resetCount(now = new Date()): Promise<void> {
  await query(
    `WITH r AS (
       UPDATE state s SET occupancy = 0, changed_at = $1
       FROM (SELECT occupancy AS was FROM state WHERE id = 1) old
       WHERE s.id = 1 RETURNING old.was
     ),
     c AS (INSERT INTO commands (device_id, type, created_at) SELECT d.id, 'reset', $1 FROM devices d, r)
     INSERT INTO events (kind, delta, occupancy_after, created_at) SELECT 'reset', -r.was, 0, $1 FROM r`,
    [now],
  );
}

// Nudges the count by hand, to correct drift without wiping it.
export async function adjustCount(delta: number, now = new Date()): Promise<void> {
  await query(
    `WITH u AS (
       UPDATE state SET
         occupancy = GREATEST(0, occupancy + $2),
         peak = GREATEST(peak, occupancy + $2),
         peak_at = CASE WHEN occupancy + $2 > peak THEN $1 ELSE peak_at END,
         changed_at = $1
       WHERE id = 1 RETURNING occupancy
     )
     INSERT INTO events (kind, delta, occupancy_after, created_at) SELECT 'adjust', $2, occupancy, $1 FROM u`,
    [now, delta],
  );
}

// Returns the new device's id and its token. The token is shown once and
// only its hash is stored.
export async function createDevice(name: string, role: Role): Promise<{ id: number; token: string }> {
  const token = newToken();
  const [row] = await query<{ id: number }>(
    `INSERT INTO devices (name, role, token_hash) VALUES ($1, $2, $3) RETURNING id`,
    [name, role, hashToken(token)],
  );
  return { id: row.id, token };
}

export async function updateDevice(id: number, name: string, role: Role): Promise<void> {
  await query(`UPDATE devices SET name = $2, role = $3 WHERE id = $1`, [id, name, role]);
}

export async function deleteDevice(id: number): Promise<void> {
  await query(`DELETE FROM devices WHERE id = $1`, [id]);
}

// Replaces a device's token; the old one stops working immediately.
export async function rotateToken(id: number): Promise<string | null> {
  const token = newToken();
  const rows = await query(`UPDATE devices SET token_hash = $2 WHERE id = $1 RETURNING id`, [id, hashToken(token)]);
  return rows.length ? token : null;
}

export async function queueCalibrate(id: number, now = new Date()): Promise<void> {
  await query(`INSERT INTO commands (device_id, type, created_at) SELECT id, 'calibrate', $2 FROM devices WHERE id = $1`, [
    id,
    now,
  ]);
}

// Changes the daily reset time ("HH:MM", local to the Rec). Marks the reset as
// already done for today so that moving the time can't wipe the count early.
export async function setResetTime(resetTime: string, now = new Date()): Promise<void> {
  await query(`UPDATE state SET reset_time = $1::time, last_reset_at = $2 WHERE id = 1`, [resetTime, now]);
}
