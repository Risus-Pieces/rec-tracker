import { levelFor, type Level, type Thresholds } from "@/lib/levels";

export const LEVEL_LABEL: Record<Level, string> = {
  quiet: "Plenty of room",
  moderate: "Getting busy",
  busy: "Packed",
};

const BARS: Record<Level, number> = { quiet: 1, moderate: 2, busy: 3 };

// How busy it is in one glance: a label, with rising bars and a color to back it up.
export function BusyBadge({ count, thresholds }: { count: number; thresholds: Thresholds }) {
  const level = levelFor(count, thresholds);
  return (
    <span className={`busy busy-${level}`}>
      <svg className="busy-bars" viewBox="0 0 18 14" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <rect
            key={i}
            x={i * 6}
            y={9 - i * 4.5}
            width="4.5"
            height={5 + i * 4.5}
            rx="1.2"
            className={i < BARS[level] ? "on" : "off"}
          />
        ))}
      </svg>
      {LEVEL_LABEL[level]}
    </span>
  );
}
