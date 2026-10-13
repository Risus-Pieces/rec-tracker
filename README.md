# Rec Tracker

A live count of how many people are inside the Rice Recreation & Wellness Center.
Small sensor units at the turnstiles count people going in and out, and a public
web page shows the number.

The count is an estimate for convenience. It is not a fire-code capacity system,
and it starts again from zero every night so small errors can't build up.
This is a student project, not an official Rice University service.

## How it fits together

```
sensor unit (ESP32 + VL53L1X)  --HTTPS-->  website (Next.js on Vercel)  -->  Postgres (Neon)
   one per turnstile                         /        public count
   entrance adds, exit subtracts             /admin   reset, recalibrate, sensor health
```

- A sensor unit can't receive connections on the Rice Visitor network, so it does
  all the talking: it **checks in** with the website, and each reply carries any
  commands waiting for it (reset, recalibrate).
- Each unit reports a running total since it powered on. The website adds only
  the change since that unit's last report, so a lost or repeated report never
  double-counts.
- Units check in the moment their count changes, and otherwise every 15 seconds.
  While the admin page is open they check in every 2 seconds so the live
  distance reading is actually live.
- The nightly reset happens on the website at a time you set on the admin page
  (default midnight, Houston time).

## What's in this folder

| Path | What it is |
| --- | --- |
| `app/page.tsx` | The public page |
| `app/admin/page.tsx` | The admin page |
| `app/api/device/checkin` | Where sensor units report |
| `app/api/occupancy` | The public count as JSON |
| `lib/tracker.ts` | All the counting rules |
| `db/schema.sql` | Database tables |
| `firmware/people_counter/` | The sketch for the ESP32 |
| `scripts/simulate-device.mjs` | A pretend sensor, for testing without hardware |
| `tests/` | Tests for the counting rules |

## Setting up a sensor unit

1. Open `/admin` on the website and sign in.
2. Under **Add a sensor**, give it a name, choose Entrance or Exit, and press
   **Add sensor**. Copy the token it shows (it is shown only once).
3. In `firmware/people_counter/`, copy `config.example.h` to `config.h` and fill in
   the WiFi name, the website address, and the token.
4. Open `firmware/people_counter/people_counter.ino` in Arduino IDE, choose
   **ESP32 Dev Module** and the right port, and upload.
5. Open the Serial Monitor at 115200 baud. You should see `WiFi connected` and
   then `Website link is up.` The sensor's card on the admin page turns **Online**.

Keep the lane clear for the first 2 seconds after power-on: that is when the unit
measures the empty lane.

## Testing without hardware

Add a sensor on the admin page, then run the simulator with its token:

```bash
node scripts/simulate-device.mjs https://your-site.vercel.app rt_your_token 4
```

It "counts" a person every 4 seconds and responds to reset and recalibrate.

## Running the website on your own computer

You need Node.js and a Postgres database.

```bash
cp .env.example .env.local   # then fill in DATABASE_URL and ADMIN_PASSWORD
npm install
DATABASE_URL=... npm run migrate
npm run dev
```

Tests need a second, empty database they are allowed to wipe:

```bash
TEST_DATABASE_URL=postgres://... npm test
```

## Deploying

The site runs on Vercel with a Neon Postgres database. It needs two environment
variables: `DATABASE_URL` (set automatically by the Neon integration) and
`ADMIN_PASSWORD`. The database tables are created or updated on every deploy.
