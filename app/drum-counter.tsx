import type { CSSProperties } from "react";

const CELLS = ["", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

// The count shown the way a turnstile shows it: digits on rolling drums.
// `value` of null shows blank drums (nothing to report yet).
export function DrumCounter({ value, minDigits = 3 }: { value: number | null; minDigits?: number }) {
  const digits = value === null ? [] : String(value).split("");
  const width = Math.max(minDigits, digits.length);
  const padded = [...Array(width - digits.length).fill(value === null ? "" : "0"), ...digits];

  return (
    <div className="drums" aria-hidden="true">
      {padded.map((digit, i) => (
        <span
          className="drum"
          // Keyed from the right so the ones drum stays the ones drum when a digit is added.
          key={width - i}
          style={{ "--cell": CELLS.indexOf(digit), "--delay": `${(width - 1 - i) * 70}ms` } as CSSProperties}
        >
          <span className="drum-strip">
            {CELLS.map((cell, n) => (
              <span key={n}>{cell}</span>
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}
