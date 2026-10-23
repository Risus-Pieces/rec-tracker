// Runs against a real Postgres, like tracker.test.ts.
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, query } from "../lib/db";
import { getDailyPeaks, getDaySeries, getTypicalWeek } from "../lib/history";
import { compareWithUsual, levelFor } from "../lib/levels";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to an empty test database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// Tuesday 13 Oct 2026, noon in Houston.
const NOW = new Date("2026-10-13T17:00:00Z");

async function event(at: string, occupancyAfter: number, kind = "count") {
  await query(`INSERT INTO events (kind, delta, occupancy_after, created_at) VALUES ($1, 0, $2, $3)`, [
    kind,
    occupancyAfter,
    at,
  ]);
}

beforeEach(async () => {
  await query("DROP TABLE IF EXISTS events, commands, devices, state CASCADE");
  await query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
});

afterAll(closePool);

describe("a day's history", () => {
  it("rebuilds the count every 10 minutes from the events log, up to now", async () => {
    await event("2026-10-13T15:00:00Z", 5); // 10:00 AM Houston
    await event("2026-10-13T16:00:00Z", 8); // 11:00 AM
    const day = await getDaySeries("2026-10-13", NOW);

    expect(day.points[0]).toEqual({ at: "2026-10-13T05:00:00.000Z", occupancy: 0 }); // midnight
    expect(day.points.at(-1)?.at).toBe("2026-10-13T17:00:00.000Z"); // stops at now
    const at = (iso: string) => day.points.find((p) => p.at === iso)?.occupancy;
    expect(at("2026-10-13T14:50:00.000Z")).toBe(0);
    expect(at("2026-10-13T15:00:00.000Z")).toBe(5);
    expect(at("2026-10-13T16:30:00.000Z")).toBe(8);
    expect(day.peak).toBe(8);
    expect(day.peakAt).toBe("2026-10-13T16:00:00.000Z");
    expect(day.firstDate).toBe("2026-10-13");
    expect(day.today).toBe("2026-10-13");
  });

  it("covers a whole past day and has nothing before the first recorded day", async () => {
    await event("2026-10-12T15:00:00Z", 3);
    const past = await getDaySeries("2026-10-12", NOW);
    expect(past.points).toHaveLength(145); // midnight to midnight, both ends
    expect(past.points.at(-1)?.occupancy).toBe(3);
    expect((await getDaySeries("2026-10-01", NOW)).points).toEqual([]);
  });

  it("lists each day's peak, newest first", async () => {
    await event("2026-10-12T15:00:00Z", 3);
    await event("2026-10-12T16:00:00Z", 9);
    await event("2026-10-13T05:00:00Z", 0, "nightly_reset");
    await event("2026-10-13T15:00:00Z", 4);
    expect(await getDailyPeaks()).toEqual([
      { date: "2026-10-13", peak: 4, peakAt: "2026-10-13T15:00:00.000Z" },
      { date: "2026-10-12", peak: 9, peakAt: "2026-10-12T16:00:00.000Z" },
    ]);
  });
});

describe("the typical week", () => {
  it("averages each weekday and hour over past weeks, leaving out today", async () => {
    // Two past Tuesdays: 20 people and then 10 people from 10 to 11 AM.
    await event("2026-09-29T15:00:00Z", 20);
    await event("2026-09-29T16:00:00Z", 0);
    await event("2026-10-06T15:00:00Z", 10);
    await event("2026-10-06T16:00:00Z", 0);
    // Today is very busy, which must not count yet.
    await event("2026-10-13T15:00:00Z", 100);

    const week = await getTypicalWeek(NOW);
    const TUESDAY = 1;
    expect(week.hours[TUESDAY][10]).toBe(15);
    expect(week.hours[TUESDAY][11]).toBe(0);
    expect(week.hours[0][10]).toBe(0); // Mondays had data, nobody there
    expect(week.days).toBe(2);
  });

  it("is empty before any data exists", async () => {
    const week = await getTypicalWeek(NOW);
    expect(week.hours.flat().every((h) => h === null)).toBe(true);
    expect(week.days).toBe(0);
  });
});

describe("labels", () => {
  const thresholds = { quietBelow: 50, busyFrom: 120 };

  it("sorts the count into plenty of room, getting busy and packed", () => {
    expect(levelFor(0, thresholds)).toBe("quiet");
    expect(levelFor(49, thresholds)).toBe("quiet");
    expect(levelFor(50, thresholds)).toBe("moderate");
    expect(levelFor(119, thresholds)).toBe("moderate");
    expect(levelFor(120, thresholds)).toBe("busy");
  });

  it("compares with the usual count, with some slack", () => {
    expect(compareWithUsual(100, 100)).toBe("usual");
    expect(compareWithUsual(119, 100)).toBe("usual");
    expect(compareWithUsual(121, 100)).toBe("busier");
    expect(compareWithUsual(79, 100)).toBe("quieter");
    expect(compareWithUsual(7, 4)).toBe("usual"); // small numbers: within 5 people
  });
});
