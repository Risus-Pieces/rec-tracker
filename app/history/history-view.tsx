"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DaySeries, DaySummary, TypicalWeek } from "@/lib/history";
import {
  WEEKDAY_NAMES,
  formatClock,
  formatDate,
  formatShortDate,
  recNow,
  shiftDate,
  weekdayOf,
} from "@/lib/format";
import { DayChart } from "../day-chart";
import { WeekHeatmap } from "../week-heatmap";

const SHOWN_DAYS = 30;

export function HistoryView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = recNow().date;
  const requested = params.get("date");
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : today;

  const [day, setDay] = useState<DaySeries | null>(null);
  const [typical, setTypical] = useState<TypicalWeek | null>(null);
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    fetch(`/api/history/day?date=${date}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: DaySeries) => !stopped && (setDay(d), setFailed(false)))
      .catch(() => !stopped && setFailed(true));
    return () => {
      stopped = true;
    };
  }, [date]);

  useEffect(() => {
    fetch("/api/history/typical")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setTypical)
      .catch(() => setFailed(true));
    fetch("/api/history/days")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setDays)
      .catch(() => setFailed(true));
  }, []);

  const go = (next: string) => router.replace(next === today ? pathname : `${pathname}?date=${next}`, { scroll: false });
  const firstDate = day?.firstDate ?? null;
  const loading = day === null || day.date !== date;
  const peakDays = days ? (showAll ? days : days.slice(0, SHOWN_DAYS)) : [];
  const maxPeak = Math.max(1, ...(days ?? []).map((d) => d.peak));

  if (days !== null && days.length === 0) {
    return (
      <p className="panel empty">
        Nothing to show yet. History starts with the first person counted at the turnstiles, so check back after a few
        days.
      </p>
    );
  }

  return (
    <>
      {failed && <p className="notice notice-warn">Can&rsquo;t reach Rec Tracker right now. Try again in a minute.</p>}

      <section className="history-section">
        <div className="day-nav">
          <button
            className="btn"
            onClick={() => go(shiftDate(date, -1))}
            disabled={firstDate !== null && date <= firstDate}
            aria-label="Previous day"
          >
            ‹
          </button>
          <h2 className="day-title">{date === today ? `Today, ${formatDate(date).split(", ")[1]}` : formatDate(date)}</h2>
          <button className="btn" onClick={() => go(shiftDate(date, 1))} disabled={date >= today} aria-label="Next day">
            ›
          </button>
          <label className="field day-pick">
            <span className="sr-only">Pick a date</span>
            <input
              type="date"
              value={date}
              min={firstDate ?? undefined}
              max={today}
              onChange={(e) => e.target.value && go(e.target.value)}
            />
          </label>
        </div>

        <div className={loading ? "is-loading" : undefined}>
          {day && day.points.length > 0 ? (
            <>
              <DayChart
                dayStart={day.points[0].at}
                points={day.points}
                usual={typical?.hours[weekdayOf(day.date)] ?? null}
                label={day.date === today ? "Today" : formatShortDate(day.date)}
                usualLabel={`Usual ${WEEKDAY_NAMES[weekdayOf(day.date)]}`}
              />
              <p className="facts">
                {day.peak > 0 && day.peakAt ? (
                  <span>
                    Busiest: <b>{day.peak}</b> people at {formatClock(day.peakAt)}
                  </span>
                ) : (
                  <span>Nobody was counted this day.</span>
                )}
              </p>
            </>
          ) : (
            day && <p className="hint">No data for this day. Rec Tracker started counting on {firstDate ? formatDate(firstDate) : "a later day"}.</p>
          )}
        </div>
      </section>

      <section className="history-section">
        <h2 className="panel-title">A typical week</h2>
        {typical && typical.days > 0 ? (
          <>
            <p className="hint section-hint">
              Average number of people at each hour, from the last {typical.days} day{typical.days === 1 ? "" : "s"} of
              counts.
            </p>
            <WeekHeatmap hours={typical.hours} />
          </>
        ) : (
          typical && <p className="hint">This fills in after the first full day of counting.</p>
        )}
      </section>

      <section className="history-section">
        <h2 className="panel-title">Every day so far</h2>
        <ol className="days">
          {peakDays.map((d) => (
            <li key={d.date}>
              <button className={`day-row${d.date === date ? " is-selected" : ""}`} onClick={() => go(d.date)}>
                <span className="day-row-date">{formatShortDate(d.date)}</span>
                <span className="day-row-bar" aria-hidden="true">
                  <span style={{ width: `${(d.peak / maxPeak) * 100}%` }} />
                </span>
                <span className="day-row-peak">
                  Peak <b>{d.peak}</b> at {formatClock(d.peakAt)}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {days && days.length > SHOWN_DAYS && !showAll && (
          <button className="btn-link" onClick={() => setShowAll(true)}>
            Show all {days.length} days
          </button>
        )}
      </section>
    </>
  );
}
