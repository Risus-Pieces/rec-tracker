"use client";

import { useEffect, useState } from "react";
import type { PublicStatus } from "@/lib/tracker";
import { formatClock } from "@/lib/format";
import { DrumCounter } from "./drum-counter";

const POLL_MS = 5000;

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

  const { lamp, label, note } = describe(status, unreachable);
  const hasCount = status !== null && status.sensors.total > 0;
  const count = hasCount ? status.occupancy : null;

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
        {note && <p className={`notice notice-${lamp}`}>{note}</p>}
        {hasCount && status.peak > 0 && status.peakAt && (
          <p className="peak">
            Busiest so far today: <strong>{status.peak}</strong> at {formatClock(status.peakAt)}
          </p>
        )}
      </section>

      <footer className="public-foot">
        <p>Counted by sensors at the turnstiles. It&rsquo;s an estimate, and it starts again from zero every night.</p>
        <p>A student project, not an official Rice University service.</p>
      </footer>
    </main>
  );
}
