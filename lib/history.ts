// Past occupancy, rebuilt from the events log. Every change to the count is an
// event that records the count right after it, so the count at any moment is
// the `occupancy_after` of the last event before that moment.
import { query } from "./db";

// One point every this many minutes on a day's chart.
const DAY_STEP_MIN = 10;
// The typical week averages this many past weeks, sampled every 15 minutes.
const TYPICAL_WEEKS = 8;

export interface DayPoint {
  at: string;
  occupancy: number;
}

export interface DaySeries {
  date: string;
  points: DayPoint[];
  peak: number;
  peakAt: string | null;
  // The first day with any data, so the history page knows how far back to go.
  firstDate: string | null;
  today: string;
}

// Midnight-to-midnight on `date` (YYYY-MM-DD, Rec local time). For today the
// series stops at `now`. A day before the first recorded event has no points.
export async function getDaySeries(date: string, now = new Date()): Promise<DaySeries> {
  const points = await query<{ at: Date; occupancy: number }>(
    `WITH s AS (SELECT timezone AS tz FROM state WHERE id = 1),
     first_event AS (SELECT min(created_at) AS at FROM events),
     span AS (
       SELECT ($1::date)::timestamp AT TIME ZONE tz AS from_at,
              LEAST(($1::date + 1)::timestamp AT TIME ZONE tz, $2::timestamptz) AS to_at
       FROM s
     )
     SELECT g AS at,
       COALESCE((SELECT occupancy_after FROM events e WHERE e.created_at <= g
                 ORDER BY e.created_at DESC, e.id DESC LIMIT 1), 0) AS occupancy
     FROM span, first_event,
       generate_series(span.from_at, span.to_at, make_interval(mins => $3)) g
     WHERE first_event.at IS NOT NULL AND span.to_at > first_event.at
     ORDER BY g`,
    [date, now, DAY_STEP_MIN],
  );
  const [summary] = await query<{ peak: number | null; peak_at: Date | null; first_date: string | null; today: string }>(
    `WITH s AS (SELECT timezone AS tz FROM state WHERE id = 1)
     SELECT
       (SELECT max(occupancy_after) FROM events, s
         WHERE (created_at AT TIME ZONE tz)::date = $1::date) AS peak,
       (SELECT created_at FROM events, s
         WHERE (created_at AT TIME ZONE tz)::date = $1::date
         ORDER BY occupancy_after DESC, created_at LIMIT 1) AS peak_at,
       (SELECT to_char(min(created_at AT TIME ZONE tz), 'YYYY-MM-DD') FROM events, s) AS first_date,
       (SELECT to_char($2::timestamptz AT TIME ZONE tz, 'YYYY-MM-DD') FROM s) AS today`,
    [date, now],
  );
  return {
    date,
    points: points.map((p) => ({ at: p.at.toISOString(), occupancy: p.occupancy })),
    peak: summary.peak ?? 0,
    peakAt: summary.peak && summary.peak_at ? summary.peak_at.toISOString() : null,
    firstDate: summary.first_date,
    today: summary.today,
  };
}

export interface TypicalWeek {
  // hours[day][hour]: average people, or null with no data. day 0 = Monday.
  hours: (number | null)[][];
  // How many past days went into the averages.
  days: number;
}

// The average count for each weekday and hour over the past few weeks,
// not counting today.
export async function getTypicalWeek(now = new Date()): Promise<TypicalWeek> {
  const rows = await query<{ dow: number; hour: number; avg: number }>(
    `WITH s AS (SELECT timezone AS tz FROM state WHERE id = 1),
     first_event AS (SELECT min(created_at) AS at FROM events),
     span AS (
       SELECT GREATEST(
                ((($1::timestamptz AT TIME ZONE tz)::date - $2 * 7)::timestamp AT TIME ZONE tz),
                date_trunc('day', first_event.at AT TIME ZONE tz) AT TIME ZONE tz
              ) AS from_at,
              ((($1::timestamptz AT TIME ZONE tz)::date)::timestamp AT TIME ZONE tz) AS to_at
       FROM s, first_event
       WHERE first_event.at IS NOT NULL
     ),
     samples AS (
       SELECT g AS at,
         COALESCE((SELECT occupancy_after FROM events e WHERE e.created_at <= g
                   ORDER BY e.created_at DESC, e.id DESC LIMIT 1), 0) AS occupancy
       FROM span, generate_series(span.from_at, span.to_at - interval '15 minutes', interval '15 minutes') g
     )
     SELECT (extract(isodow FROM at AT TIME ZONE tz) - 1)::int AS dow,
            extract(hour FROM at AT TIME ZONE tz)::int AS hour,
            avg(occupancy)::float AS avg
     FROM samples, s
     GROUP BY 1, 2`,
    [now, TYPICAL_WEEKS],
  );
  const hours: (number | null)[][] = Array.from({ length: 7 }, () => Array(24).fill(null));
  for (const row of rows) {
    hours[row.dow][row.hour] = Math.round(row.avg * 10) / 10;
  }
  const [count] = await query<{ days: number }>(
    `WITH s AS (SELECT timezone AS tz FROM state WHERE id = 1)
     SELECT count(DISTINCT (created_at AT TIME ZONE tz)::date)::int AS days FROM events, s
     WHERE created_at >= $1::timestamptz - make_interval(days => $2 * 7)
       AND (created_at AT TIME ZONE tz)::date < ($1::timestamptz AT TIME ZONE tz)::date`,
    [now, TYPICAL_WEEKS],
  );
  return { hours, days: count.days };
}

export interface DaySummary {
  date: string;
  peak: number;
  peakAt: string;
}

// Each day's busiest moment, newest first.
export async function getDailyPeaks(limit = 120): Promise<DaySummary[]> {
  const rows = await query<{ date: string; peak: number; peak_at: Date }>(
    `WITH s AS (SELECT timezone AS tz FROM state WHERE id = 1),
     days AS (
       SELECT DISTINCT ON ((created_at AT TIME ZONE tz)::date)
         to_char(created_at AT TIME ZONE tz, 'YYYY-MM-DD') AS date, occupancy_after AS peak, created_at AS peak_at
       FROM events, s
       ORDER BY (created_at AT TIME ZONE tz)::date DESC, occupancy_after DESC, created_at
     )
     SELECT * FROM days ORDER BY date DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ date: r.date, peak: r.peak, peakAt: r.peak_at.toISOString() }));
}
