// Runs against a real Postgres. Point TEST_DATABASE_URL at an empty database;
// the tables are dropped and recreated before every test.
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, query } from "../lib/db";
import {
  adjustCount,
  applyNightlyReset,
  checkIn,
  createDevice,
  getAdminStatus,
  getPublicStatus,
  queueCalibrate,
  resetCount,
  rotateToken,
  setResetTime,
} from "../lib/tracker";

// These tests drop tables, so they only ever run against TEST_DATABASE_URL.
if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to an empty test database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// Noon Central on a fixed day, so nothing here depends on the real clock.
const NOON = new Date("2026-10-13T17:00:00Z");
const at = (secondsAfterNoon: number) => new Date(NOON.getTime() + secondsAfterNoon * 1000);

beforeEach(async () => {
  await query("DROP TABLE IF EXISTS events, commands, devices, state CASCADE");
  await query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await query("UPDATE state SET last_reset_at = $1, changed_at = $1", [NOON]);
});

afterAll(closePool);

describe("counting", () => {
  it("adds entrance counts and subtracts exit counts", async () => {
    const entrance = await createDevice("Entrance A", "entrance");
    const exit = await createDevice("Exit", "exit");

    expect((await checkIn(entrance.token, { boot: "e1", total: 5 }, at(1)))?.occupancy).toBe(5);
    expect((await checkIn(exit.token, { boot: "x1", total: 2 }, at(2)))?.occupancy).toBe(3);
  });

  it("counts only what is new since the device's last report", async () => {
    const { token } = await createDevice("Entrance A", "entrance");
    await checkIn(token, { boot: "b1", total: 3 }, at(1));
    const result = await checkIn(token, { boot: "b1", total: 7 }, at(2));
    expect(result?.delta).toBe(4);
    expect(result?.occupancy).toBe(7);
  });

  it("does not double-count a repeated or out-of-order report", async () => {
    const { token } = await createDevice("Entrance A", "entrance");
    await checkIn(token, { boot: "b1", total: 7 }, at(1));
    expect((await checkIn(token, { boot: "b1", total: 7 }, at(2)))?.delta).toBe(0);
    expect((await checkIn(token, { boot: "b1", total: 4 }, at(3)))?.delta).toBe(0);
    expect((await checkIn(token, { boot: "b1", total: 8 }, at(4)))?.occupancy).toBe(8);
  });

  it("treats a rebooted device's total as all new", async () => {
    const { token } = await createDevice("Entrance A", "entrance");
    await checkIn(token, { boot: "b1", total: 10 }, at(1));
    const result = await checkIn(token, { boot: "b2", total: 2 }, at(2));
    expect(result?.delta).toBe(2);
    expect(result?.occupancy).toBe(12);
  });

  it("never lets the count go below zero", async () => {
    const exit = await createDevice("Exit", "exit");
    expect((await checkIn(exit.token, { boot: "x1", total: 4 }, at(1)))?.occupancy).toBe(0);
  });

  it("applies simultaneous check-ins from different devices without losing any", async () => {
    const a = await createDevice("Entrance A", "entrance");
    const b = await createDevice("Entrance B", "entrance");
    const exit = await createDevice("Exit", "exit");
    await checkIn(a.token, { boot: "a", total: 20 }, at(1));
    await Promise.all([
      checkIn(a.token, { boot: "a", total: 23 }, at(2)),
      checkIn(b.token, { boot: "b", total: 4 }, at(2)),
      checkIn(exit.token, { boot: "x", total: 5 }, at(2)),
    ]);
    expect((await getPublicStatus(at(3))).occupancy).toBe(22);
  });

  it("rejects an unknown token and a rotated-out token", async () => {
    const device = await createDevice("Entrance A", "entrance");
    expect(await checkIn("rt_wrong", { boot: "b", total: 1 }, at(1))).toBeNull();
    const fresh = await rotateToken(device.id);
    expect(await checkIn(device.token, { boot: "b", total: 1 }, at(2))).toBeNull();
    expect((await checkIn(fresh!, { boot: "b", total: 1 }, at(3)))?.occupancy).toBe(1);
  });

  it("tracks the day's peak", async () => {
    const entrance = await createDevice("Entrance A", "entrance");
    const exit = await createDevice("Exit", "exit");
    await checkIn(entrance.token, { boot: "e", total: 9 }, at(10));
    await checkIn(exit.token, { boot: "x", total: 6 }, at(20));
    const status = await getPublicStatus(at(30));
    expect(status.occupancy).toBe(3);
    expect(status.peak).toBe(9);
    expect(status.peakAt).toBe(at(10).toISOString());
  });
});

describe("nightly reset", () => {
  // Default reset time is 00:00 Central, which is 05:00 UTC in October.
  const BEFORE_MIDNIGHT = new Date("2026-10-14T04:59:00Z");
  const AFTER_MIDNIGHT = new Date("2026-10-14T05:01:00Z");

  it("leaves the count alone before the reset time", async () => {
    await adjustCount(8, at(1));
    expect(await applyNightlyReset(BEFORE_MIDNIGHT)).toBe(false);
    expect((await getPublicStatus(BEFORE_MIDNIGHT)).occupancy).toBe(8);
  });

  it("zeroes the count and the peak once the reset time passes, exactly once", async () => {
    const { token } = await createDevice("Entrance A", "entrance");
    await checkIn(token, { boot: "b", total: 8 }, at(1));
    const status = await getPublicStatus(AFTER_MIDNIGHT);
    expect(status.occupancy).toBe(0);
    expect(status.peak).toBe(0);

    await checkIn(token, { boot: "b", total: 9 }, new Date(AFTER_MIDNIGHT.getTime() + 60_000));
    expect(await applyNightlyReset(new Date(AFTER_MIDNIGHT.getTime() + 120_000))).toBe(false);
    expect((await getPublicStatus(new Date(AFTER_MIDNIGHT.getTime() + 120_000))).occupancy).toBe(1);
  });

  it("tells devices to zero their own display", async () => {
    const { token } = await createDevice("Entrance A", "entrance");
    const result = await checkIn(token, { boot: "b", total: 0 }, AFTER_MIDNIGHT);
    expect(result?.commands.map((c) => c.type)).toEqual(["reset"]);
  });

  it("follows a changed reset time without wiping the count early", async () => {
    await adjustCount(5, at(1));
    await setResetTime("22:30", at(2)); // 22:30 Central = 03:30 UTC
    expect((await getPublicStatus(new Date("2026-10-14T03:29:00Z"))).occupancy).toBe(5);
    expect((await getPublicStatus(new Date("2026-10-14T03:31:00Z"))).occupancy).toBe(0);
  });
});

describe("commands", () => {
  it("delivers a recalibrate request until the device acknowledges it", async () => {
    const { id, token } = await createDevice("Entrance A", "entrance");
    await queueCalibrate(id, at(1));

    const first = await checkIn(token, { boot: "b", total: 0 }, at(2));
    expect(first?.commands).toHaveLength(1);
    expect(first?.commands[0].type).toBe("calibrate");
    const commandId = first!.commands[0].id;

    // Not acknowledged yet (still calibrating): offered again.
    expect((await checkIn(token, { boot: "b", total: 0 }, at(4)))?.commands).toHaveLength(1);
    expect((await getAdminStatus(at(4))).devices[0].calibration?.state).toBe("running");

    expect((await checkIn(token, { boot: "b", total: 0, ack: commandId }, at(6)))?.commands).toHaveLength(0);
    expect((await getAdminStatus(at(6))).devices[0].calibration?.state).toBe("done");
  });

  it("only sends a command to the device it was meant for", async () => {
    const a = await createDevice("Entrance A", "entrance");
    const b = await createDevice("Entrance B", "entrance");
    await queueCalibrate(a.id, at(1));
    expect((await checkIn(b.token, { boot: "b", total: 0 }, at(2)))?.commands).toHaveLength(0);
  });

  it("drops a command the device was too late to pick up", async () => {
    const { id, token } = await createDevice("Entrance A", "entrance");
    await queueCalibrate(id, at(1));
    expect((await checkIn(token, { boot: "b", total: 0 }, at(200)))?.commands).toHaveLength(0);
    expect((await getAdminStatus(at(200))).devices[0].calibration?.state).toBe("expired");
  });

  it("resets the count from the admin page and tells devices", async () => {
    const { token } = await createDevice("Entrance A", "entrance");
    await checkIn(token, { boot: "b", total: 6 }, at(1));
    await resetCount(at(2));
    const result = await checkIn(token, { boot: "b", total: 6 }, at(3));
    expect(result?.occupancy).toBe(0);
    expect(result?.commands.map((c) => c.type)).toEqual(["reset"]);
  });
});

describe("status", () => {
  it("reports which sensors are online", async () => {
    const a = await createDevice("Entrance A", "entrance");
    await createDevice("Exit", "exit");
    await checkIn(a.token, { boot: "b", total: 0 }, at(1));
    expect((await getPublicStatus(at(10))).sensors).toEqual({ total: 2, online: 1 });
    expect((await getPublicStatus(at(120))).sensors).toEqual({ total: 2, online: 0 });
  });

  it("asks devices to check in faster while the admin page is open", async () => {
    const { token } = await createDevice("Entrance A", "entrance");
    expect((await checkIn(token, { boot: "b", total: 0 }, at(1)))?.intervalMs).toBe(15000);
    await getAdminStatus(at(2));
    expect((await checkIn(token, { boot: "b", total: 0 }, at(3)))?.intervalMs).toBe(2000);
    expect((await checkIn(token, { boot: "b", total: 0 }, at(60)))?.intervalMs).toBe(15000);
  });

  it("stores the health a device reports and logs count changes", async () => {
    const { token } = await createDevice("Entrance A", "entrance");
    await checkIn(
      token,
      { boot: "b", total: 2, count: 2, mm: 412, baseline: 980, threshold: 780, present: true, rate: 30, sensorOk: true, status: "valid", restarts: 1, uptimeS: 3600, rssi: -61, firmware: "2.0.0", failures: 3, lastError: -11, resetReason: "power on", freeHeap: 181000 },
      at(1),
    );
    const status = await getAdminStatus(at(2));
    expect(status.devices[0]).toMatchObject({
      online: true, distanceMm: 412, baselineMm: 980, thresholdMm: 780, present: true,
      readingsPerSec: 30, sensorOk: true, sensorStatus: "valid", sensorRestarts: 1, uptimeS: 3600, rssi: -61, firmware: "2.0.0",
      checkinFailures: 3, lastError: -11, resetReason: "power on", freeHeap: 181000,
    });
    expect(status.events[0]).toMatchObject({ kind: "count", device: "Entrance A", delta: 2, occupancyAfter: 2 });
  });
});
