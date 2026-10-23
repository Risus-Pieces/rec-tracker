// How busy the Rec is, in words. No server imports, so pages can use it too.

export type Level = "quiet" | "moderate" | "busy";

export interface Thresholds {
  // Fewer people than this is "plenty of room".
  quietBelow: number;
  // This many or more is "packed".
  busyFrom: number;
}

export function levelFor(count: number, t: Thresholds): Level {
  if (count >= t.busyFrom) return "busy";
  if (count < t.quietBelow) return "quiet";
  return "moderate";
}

export type Comparison = "quieter" | "usual" | "busier";

// Compares now with the usual count for this hour. Within 20% (or 5 people,
// for small numbers) counts as usual.
export function compareWithUsual(count: number, usual: number): Comparison {
  const margin = Math.max(5, usual * 0.2);
  if (count > usual + margin) return "busier";
  if (count < usual - margin) return "quieter";
  return "usual";
}
