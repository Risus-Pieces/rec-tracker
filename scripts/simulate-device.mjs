// Pretends to be a sensor unit, for testing the web app without hardware.
//
//   node scripts/simulate-device.mjs <site-url> <device-token> [seconds-between-people]
//
// It follows the same rules as the firmware: reports a running total, obeys
// the check-in rate the server asks for, and runs reset/recalibrate commands.
const [site, token, everyArg] = process.argv.slice(2);
if (!site || !token) {
  console.error("usage: node scripts/simulate-device.mjs <site-url> <device-token> [seconds-between-people]");
  process.exit(1);
}
const secondsBetweenPeople = Number(everyArg ?? 4);

const boot = Math.random().toString(16).slice(2, 10);
const started = Date.now();
let total = 0;
let count = 0;
let baseline = 960 + Math.round(Math.random() * 40);
let present = false;
let lastSeenCommand = 0;
let ack = 0;
let intervalMs = 15000;
let sentTotal = -1;

// Someone walks through every few seconds and blocks the beam for ~0.6 s.
setInterval(() => {
  present = true;
  setTimeout(() => {
    present = false;
    total++;
    count++;
  }, 600);
}, secondsBetweenPeople * 1000);

async function checkIn() {
  const report = {
    boot,
    total,
    count,
    mm: present ? 300 + Math.round(Math.random() * 80) : baseline + Math.round(Math.random() * 10 - 5),
    baseline,
    threshold: baseline - 200,
    present,
    rate: 30,
    sensor_ok: true,
    status: "valid",
    restarts: 0,
    uptime_s: Math.round((Date.now() - started) / 1000),
    rssi: -58,
    fw: "simulator",
    ack,
  };
  const response = await fetch(new URL("/api/device/checkin", site), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(report),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body.error}`);
  sentTotal = report.total;
  intervalMs = body.interval_ms;
  for (const command of body.commands) {
    if (command.id <= lastSeenCommand) continue;
    lastSeenCommand = command.id;
    if (command.type === "reset") {
      count = 0;
      ack = command.id;
      console.log("command: reset");
    } else if (command.type === "calibrate") {
      console.log("command: recalibrate (2 s)");
      setTimeout(() => {
        baseline = 960 + Math.round(Math.random() * 40);
        ack = command.id;
      }, 2000);
    }
  }
  console.log(`total ${report.total}  occupancy ${body.occupancy}  next check-in ${intervalMs} ms`);
}

let lastCheckIn = 0;
setInterval(async () => {
  const due = Date.now() - lastCheckIn >= intervalMs;
  const changed = total !== sentTotal && Date.now() - lastCheckIn >= 1000;
  if (!due && !changed) return;
  lastCheckIn = Date.now();
  try {
    await checkIn();
  } catch (error) {
    console.error("check-in failed:", error.message);
  }
}, 100);
