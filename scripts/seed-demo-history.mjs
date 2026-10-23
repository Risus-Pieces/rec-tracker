// Fills a LOCAL database with made-up history (six weeks of a plausible
// gym day), so the charts and history page can be checked before real data
// exists. It refuses to run against anything but localhost.
//
//   DATABASE_URL=postgres://...@127.0.0.1/... node scripts/seed-demo-history.mjs
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to a local database.");
  process.exit(1);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`Refusing to write demo data to ${host}. This script is for local databases only.`);
  process.exit(1);
}

const TZ = "America/Chicago";
const WEEKS = 6;

// Rough people-in-the-building target by hour, weekday and weekend.
const WEEKDAY = [0, 0, 0, 0, 0, 0, 10, 35, 45, 30, 25, 35, 55, 40, 35, 55, 95, 130, 140, 110, 75, 45, 20, 0];
const WEEKEND = [0, 0, 0, 0, 0, 0, 0, 0, 15, 30, 45, 55, 60, 60, 55, 50, 50, 55, 50, 40, 25, 10, 0, 0];

const pad = (n) => String(n).padStart(2, "0");
const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
const nowParts = Object.fromEntries(
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(new Date())
    .map((p) => [p.type, p.value]),
);
const today = isoDate.format(new Date());
const nowMinute = Number(nowParts.hour) * 60 + Number(nowParts.minute);

const times = [];
const values = [];
const kinds = [];
let occupancy = 0;

const start = new Date(`${today}T12:00:00Z`);
start.setUTCDate(start.getUTCDate() - WEEKS * 7);
for (let d = new Date(start); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
  const date = d.toISOString().slice(0, 10);
  const weekday = (d.getUTCDay() + 6) % 7;
  const curve = weekday >= 5 ? WEEKEND : WEEKDAY;
  const mood = 0.8 + Math.random() * 0.4; // some days are just busier
  occupancy = 0;
  times.push(`${date} 00:00:00`);
  values.push(0);
  kinds.push("nightly_reset");

  const lastMinute = date === today ? nowMinute : 24 * 60 - 1;
  for (let minute = 0; minute <= lastMinute; minute += 1 + Math.floor(Math.random() * 3)) {
    const h = Math.floor(minute / 60);
    const next = curve[Math.min(23, h + 1)];
    const target = (curve[h] + (next - curve[h]) * ((minute % 60) / 60)) * mood;
    const pull = (target - occupancy) / 6 + (Math.random() - 0.5) * 4;
    const change = Math.round(pull);
    if (change === 0) continue;
    occupancy = Math.max(0, occupancy + change);
    times.push(`${date} ${pad(h)}:${pad(minute % 60)}:${pad(Math.floor(Math.random() * 60))}`);
    values.push(occupancy);
    kinds.push("count");
  }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("DELETE FROM events");
  await client.query(
    `INSERT INTO events (kind, delta, occupancy_after, created_at)
     SELECT k, 0, v, (t::timestamp AT TIME ZONE $4) FROM unnest($1::text[], $2::int[], $3::text[]) AS x(t, v, k)`,
    [times, values, kinds, TZ],
  );
  await client.query(
    `UPDATE state SET occupancy = $1, changed_at = now(), last_reset_at = now(),
       peak = (SELECT max(occupancy_after) FROM events WHERE (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)
     WHERE id = 1`,
    [occupancy, TZ],
  );
  await client.query("COMMIT");
  console.log(`Wrote ${times.length} demo events over ${WEEKS} weeks. Count now: ${occupancy}.`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
