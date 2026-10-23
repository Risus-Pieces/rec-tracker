"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatClock, formatHour } from "@/lib/format";

export interface ChartPoint {
  at: string;
  occupancy: number;
}

interface Props {
  // Local midnight that starts the day being shown.
  dayStart: string;
  // The day's count. May stop partway (today).
  points: ChartPoint[];
  // Usual count for each hour of this weekday (24 values), or null with no history.
  usual: (number | null)[] | null;
  label: string;
  usualLabel: string;
}

const HOUR = 3_600_000;
const HEIGHT = 220;
const M = { top: 14, right: 14, bottom: 26, left: 34 };

// Round up to a clean axis maximum: 10, 20, 25, 50, 100, 150, 200...
function niceMax(value: number): number {
  const steps = [10, 20, 25, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];
  return steps.find((s) => s >= value) ?? Math.ceil(value / 500) * 500;
}

// The count through one day, with the usual pattern for that weekday behind it.
export function DayChart({ dayStart, points, usual, label, usualLabel }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const start = new Date(dayStart).getTime();
  const hasUsual = usual?.some((v) => v !== null) ?? false;

  // Start the axis at 6 AM unless people were there earlier.
  const firstBusyHour = Math.min(
    ...points.filter((p) => p.occupancy > 0).map((p) => Math.floor((new Date(p.at).getTime() - start) / HOUR)),
    ...(usual ?? []).map((v, h) => (v && v > 0 ? h : 24)),
    6,
  );
  const fromHour = Math.max(0, firstBusyHour);
  const x0 = start + fromHour * HOUR;
  const x1 = start + 24 * HOUR;
  const shown = points.filter((p) => new Date(p.at).getTime() >= x0);

  const top = niceMax(Math.max(10, ...shown.map((p) => p.occupancy), ...(usual ?? []).map((v) => v ?? 0)));
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - x0) / (x1 - x0)) * plotW;
  const y = (v: number) => M.top + plotH - (v / top) * plotH;

  // One hover position per hour step on the axis, so "usual" stays readable past the end of today.
  const slots = Array.from({ length: (24 - fromHour) * 6 + 1 }, (_, i) => x0 + i * 10 * 60_000);
  const valueAt = (t: number) => {
    let found: number | null = null;
    for (const p of shown) {
      if (new Date(p.at).getTime() <= t) found = p.occupancy;
      else break;
    }
    const last = shown.at(-1);
    return last && t > new Date(last.at).getTime() + 10 * 60_000 ? null : found;
  };
  const usualAt = (t: number) => (usual ? (usual[Math.floor((t - start) / HOUR)] ?? null) : null);

  const todayPath = shown.map((p, i) => `${i ? "L" : "M"}${x(new Date(p.at).getTime())},${y(p.occupancy)}`).join("");
  const areaPath =
    shown.length > 1
      ? `${todayPath}L${x(new Date(shown.at(-1)!.at).getTime())},${y(0)}L${x(new Date(shown[0].at).getTime())},${y(0)}Z`
      : "";
  const usualPoints = (usual ?? [])
    .map((v, h) => (v === null || h < fromHour ? null : { t: start + (h + 0.5) * HOUR, v }))
    .filter((p): p is { t: number; v: number } => p !== null);
  const usualPath = usualPoints.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v)}`).join("");
  const last = shown.at(-1);

  const tickEvery = plotW < 420 ? 6 : 3;
  const ticks = [];
  for (let h = Math.ceil(fromHour / tickEvery) * tickEvery; h <= 24; h += tickEvery) ticks.push(h);

  function onPointer(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const t = x0 + ((event.clientX - rect.left - M.left) / plotW) * (x1 - x0);
    setActive(Math.max(0, Math.min(slots.length - 1, Math.round((t - x0) / (10 * 60_000)))));
  }

  function onKey(event: KeyboardEvent<SVGSVGElement>) {
    const step = event.shiftKey ? 6 : 1;
    if (event.key === "ArrowRight") setActive((a) => Math.min(slots.length - 1, (a ?? -1) + step));
    else if (event.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? slots.length) - step));
    else if (event.key === "Escape") setActive(null);
    else return;
    event.preventDefault();
  }

  const activeT = active === null ? null : slots[active];
  const activeValue = activeT === null ? null : valueAt(activeT);
  const activeUsual = activeT === null ? null : usualAt(activeT);
  const tipLeft = activeT === null ? 0 : Math.min(Math.max(x(activeT), 70), width - 70);

  return (
    <figure className="chart">
      <figcaption className="chart-legend">
        <span className="key key-today">{label}</span>
        {hasUsual && <span className="key key-usual">{usualLabel}</span>}
      </figcaption>
      <div className="chart-box" ref={box}>
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`${label}: people in the Rec through the day. Use the arrow keys to read values.`}
            tabIndex={0}
            onPointerMove={onPointer}
            onPointerLeave={() => setActive(null)}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
          >
            {[0, top / 2, top].map((v) => (
              <g key={v}>
                <line className="grid" x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} />
                <text className="tick" x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                  {v}
                </text>
              </g>
            ))}
            {ticks.map((h) => (
              <text
                key={h}
                className="tick"
                x={x(start + h * HOUR)}
                y={HEIGHT - 6}
                textAnchor={h === 24 ? "end" : h === fromHour ? "start" : "middle"}
              >
                {formatHour(h)}
              </text>
            ))}
            {usualPath && <path className="line-usual" d={usualPath} />}
            {areaPath && <path className="area-today" d={areaPath} />}
            {todayPath && <path className="line-today" d={todayPath} />}
            {last && <circle className="dot-today" cx={x(new Date(last.at).getTime())} cy={y(last.occupancy)} r="4.5" />}
            {activeT !== null && (
              <g>
                <line className="crosshair" x1={x(activeT)} x2={x(activeT)} y1={M.top} y2={M.top + plotH} />
                {activeUsual !== null && <circle className="dot-usual" cx={x(activeT)} cy={y(activeUsual)} r="4" />}
                {activeValue !== null && <circle className="dot-today" cx={x(activeT)} cy={y(activeValue)} r="4.5" />}
              </g>
            )}
          </svg>
        )}
        {activeT !== null && (
          <div className="tip" style={{ left: tipLeft }} aria-live="polite">
            <div className="tip-time">{formatClock(new Date(activeT).toISOString())}</div>
            {activeValue !== null && (
              <div className="tip-row">
                <span className="key key-today" />
                <strong>{activeValue}</strong> {label.toLowerCase()}
              </div>
            )}
            {activeUsual !== null && (
              <div className="tip-row">
                <span className="key key-usual" />
                <strong>{Math.round(activeUsual)}</strong> usually
              </div>
            )}
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Hour</th>
              <th scope="col">{label}</th>
              {hasUsual && <th scope="col">Usually</th>}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 24 - fromHour }, (_, i) => fromHour + i).map((h) => {
              const v = valueAt(start + h * HOUR);
              const u = usual?.[h];
              return (
                <tr key={h}>
                  <th scope="row">{formatHour(h)}</th>
                  <td>{v ?? "–"}</td>
                  {hasUsual && <td>{u === null || u === undefined ? "–" : Math.round(u)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
