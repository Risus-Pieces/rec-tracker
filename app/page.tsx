"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { PublicStatus } from "@/lib/tracker";
import type { DaySeries, TypicalWeek } from "@/lib/history";
import { compareWithUsual } from "@/lib/levels";
import { WEEKDAY_NAMES, formatClock, formatHour, recNow } from "@/lib/format";
import { AboutDialog } from "./about-dialog";
import { BusyBadge } from "./busy-badge";
import { DayChart } from "./day-chart";
import { DrumCounter } from "./drum-counter";

const POLL_MS = 5000;
const CHART_POLL_MS = 60_000;
const TYPICAL_POLL_MS = 30 * 60_000;

// Fetches JSON every so often while the tab is visible.
function usePolled<T>(url: string, everyMs: number): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const response = await fetch(url);
        if (response.ok && !stopped) setData(await response.json());
      } catch {
        // Keep the last good data; the live count shows the connection problem.
      }
    }
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), everyMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [url, everyMs]);
  return data;
}

const COMPARED: Record<ReturnType<typeof compareWithUsual>, string> = {
  quieter: "Quieter than usual",
  usual: "About as busy as usual",
  busier: "Busier than usual",
};

type Lamp = "go" | "warn" | "off";

// Turns the raw status into the one line that tells a visitor whether to trust the number.
function describe(status: PublicStatus | null, unreachable: boolean): { lamp: Lamp; label: string; note: string | null } {
  if (!status) {
    return unreachable
      ? { lamp: "warn", label: "No connection", note: "Can't reach Rec Tracker. Check your connection; this page keeps trying." }
      : { lamp: "off", label: "Connecting", note: null };
  }
  if (unreachable) {
    return { lamp: "warn", label: "No connection", note: "Can't reach Rec Tracker, so this is the last count it sent. This page keeps trying." };
  }
  const { total, online } = status.sensors;
  if (total === 0) return { lamp: "off", label: "Not set up", note: "No sensor is connected yet, so there is no count to show." };
  if (online === 0) {
    const since = status.lastSeenAt ? ` since ${formatClock(status.lastSeenAt)}` : "";
    return { lamp: "warn", label: "Sensor offline", note: `The turnstile sensors have been offline${since}. This number may be out of date.` };
  }
  if (online < total) {
    const offline = total - online;
    return { lamp: "warn", label: "Partly offline", note: `${offline} of ${total} turnstile sensors ${offline === 1 ? "is" : "are"} offline, so the count may drift.` };
  }
  return { lamp: "go", label: "Live", note: null };
}

export default function Home() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  // The Rec's weekday and hour, refreshed with each update (never during render).
  const [now, setNow] = useState<ReturnType<typeof recNow> | null>(null);

  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const response = await fetch("/api/occupancy");
        if (!response.ok) throw new Error(String(response.status));
        const next: PublicStatus = await response.json();
        if (!stopped) {
          setStatus(next);
          setUnreachable(false);
          setNow(recNow());
        }
      } catch {
        if (!stopped) setUnreachable(true);
      }
    }
    refresh();
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const today = usePolled<DaySeries>("/api/history/day", CHART_POLL_MS);
  const typical = usePolled<TypicalWeek>("/api/history/typical", TYPICAL_POLL_MS);

  const { lamp, label, note } = describe(status, unreachable);
  const hasCount = status !== null && status.sensors.total > 0;
  const count = hasCount ? status.occupancy : null;
  // Only judge how busy it is when the count is live.
  const live = hasCount && status.sensors.online > 0 && !unreachable;

  const usualNow = now && typical && typical.days > 0 ? typical.hours[now.day][now.hour] : null;

  // Today's chart, with the live count as its newest point.
  const todayPoints = today?.points ?? [];
  const lastPoint = todayPoints.at(-1);
  const points =
    live && status && lastPoint && status.serverTime > lastPoint.at
      ? [...todayPoints, { at: status.serverTime, occupancy: status.occupancy }]
      : todayPoints;

  return (
    <main className="public">
      <header className="public-head">
        <span className="wordmark">Rec Tracker</span>
        <span className={`lamp lamp-${lamp}`}>{label}</span>
      </header>

      <section className="public-main">
        <h1 className="eyebrow">In the Rice Rec right now</h1>
        <div className="readout">
          <DrumCounter value={count} />
          <span className="unit">{count === 1 ? "person" : "people"}</span>
        </div>
        <p className="sr-only" aria-live="polite">
          {count === null ? "No count available." : `${count} ${count === 1 ? "person" : "people"} in the Rice Rec right now.`}
        </p>
        {live && now && (
          <div className="verdict">
            <BusyBadge count={status.occupancy} thresholds={status.thresholds} />
            {usualNow !== null && (
              <p className="usual">
                {COMPARED[compareWithUsual(status.occupancy, usualNow)]} for a {WEEKDAY_NAMES[now.day]} at{" "}
                {formatHour(now.hour)}, when there are usually about <strong>{Math.round(usualNow)}</strong>.
              </p>
            )}
          </div>
        )}
        {note && <p className={`notice notice-${lamp}`}>{note}</p>}
        {hasCount && status.peak > 0 && status.peakAt && (
          <p className="peak">
            Busiest so far today: <strong>{status.peak}</strong> at {formatClock(status.peakAt)}
          </p>
        )}
      </section>

      {points.length > 0 && now && (
        <section className="public-today">
          <div className="section-head">
            <h2 className="panel-title">Today so far</h2>
            <Link href="/history" className="more-link">
              Full history
            </Link>
          </div>
          <DayChart
            dayStart={points[0].at}
            points={points}
            usual={typical && typical.days > 0 ? typical.hours[now.day] : null}
            label="Today"
            usualLabel={`Usual ${WEEKDAY_NAMES[now.day]}`}
          />
        </section>
      )}

      <footer className="public-foot">
        <AboutDialog />
      </footer>
    </main>
  );
}
