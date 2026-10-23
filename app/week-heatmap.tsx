"use client";

import { useState, type CSSProperties } from "react";
import { WEEKDAY_PLURAL, WEEKDAY_SHORT, formatHour, recNow } from "@/lib/format";

interface Props {
  // hours[day][hour], day 0 = Monday; null where there's no data.
  hours: (number | null)[][];
}

// The usual count for every weekday and hour: darker means busier.
export function WeekHeatmap({ hours }: Props) {
  const [tip, setTip] = useState<{ day: number; hour: number; left: number; top: number } | null>(null);
  const now = recNow();

  // Only the hours anyone is ever there, from 6 AM at the latest.
  const busyHours = hours.flatMap((row) => row.map((v, h) => (v && v > 0 ? h : null))).filter((h) => h !== null);
  const from = Math.min(6, ...busyHours);
  const to = Math.max(22, ...busyHours);
  const columns = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(1, ...hours.flat().map((v) => v ?? 0));
  // 8% ink at zero up to 92% at the busiest hour of the week.
  const shade = (v: number) => `${Math.round(8 + (v / max) * 84)}%`;

  return (
    <figure className="heatmap">
      <div className="heatmap-scroll">
        <div
          className="heatmap-grid"
          role="table"
          aria-label="Usual number of people by weekday and hour"
          style={{ "--cols": columns.length } as CSSProperties}
          onPointerLeave={() => setTip(null)}
        >
          <div role="row" className="heatmap-row">
            <span role="columnheader" />
            {columns.map((h) => (
              <span role="columnheader" key={h} className="heatmap-hour">
                {h % 3 === 0 ? formatHour(h).replace(" ", "").toLowerCase() : ""}
              </span>
            ))}
          </div>
          {hours.map((row, day) => (
            <div role="row" className="heatmap-row" key={day}>
              <span role="rowheader" className="heatmap-day">
                {WEEKDAY_SHORT[day]}
              </span>
              {columns.map((h) => {
                const v = row[h];
                const isNow = day === now.day && h === now.hour;
                return (
                  <span
                    role="cell"
                    key={h}
                    aria-label={`${WEEKDAY_PLURAL[day]} at ${formatHour(h)}: ${v === null ? "no data yet" : `usually ${Math.round(v)} people`}`}
                    className={`heatmap-cell${v === null ? " is-empty" : ""}${isNow ? " is-now" : ""}`}
                    style={v === null ? undefined : ({ "--shade": shade(v) } as CSSProperties)}
                    onPointerEnter={(e) => {
                      const cell = e.currentTarget.getBoundingClientRect();
                      const grid = e.currentTarget.closest(".heatmap")!.getBoundingClientRect();
                      setTip({ day, hour: h, left: cell.left - grid.left + cell.width / 2, top: cell.top - grid.top });
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {tip && (
        <div className="tip tip-above" style={{ left: tip.left, top: tip.top }}>
          <div className="tip-time">
            {WEEKDAY_PLURAL[tip.day]}, {formatHour(tip.hour)}
          </div>
          <div className="tip-row">
            {hours[tip.day][tip.hour] === null ? (
              "No data yet"
            ) : (
              <>
                <strong>{Math.round(hours[tip.day][tip.hour]!)}</strong> people usually
              </>
            )}
          </div>
        </div>
      )}
      <figcaption className="heatmap-scale">
        <span>Fewer people</span>
        <span className="heatmap-ramp" aria-hidden="true" />
        <span>More (up to {Math.round(max)})</span>
        <span className="heatmap-now-key">Outlined: right now</span>
      </figcaption>
    </figure>
  );
}
