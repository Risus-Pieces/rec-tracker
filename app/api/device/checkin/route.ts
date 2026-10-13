import { checkIn, type CheckInReport } from "@/lib/tracker";

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : null;
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const text = (v: unknown, maxLength: number): string | null => (typeof v === "string" ? v.slice(0, maxLength) : null);

// Called by each sensor unit: reports its running total and health, and gets
// back the commands waiting for it and how soon to check in again.
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return Response.json({ ok: false, error: "missing token" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "body must be JSON" }, { status: 400 });
  }

  const boot = text(body.boot, 32);
  const total = int(body.total, 0, 1_000_000_000);
  if (!boot || total === null) {
    return Response.json({ ok: false, error: "boot and total are required" }, { status: 400 });
  }

  const report: CheckInReport = {
    boot,
    total,
    count: int(body.count, 0, 1_000_000_000),
    mm: int(body.mm, 0, 10_000),
    baseline: int(body.baseline, 0, 10_000),
    threshold: int(body.threshold, 0, 10_000),
    present: bool(body.present),
    rate: int(body.rate, 0, 1000),
    sensorOk: bool(body.sensor_ok),
    status: text(body.status, 40),
    restarts: int(body.restarts, 0, 1_000_000_000),
    uptimeS: int(body.uptime_s, 0, 1_000_000_000),
    rssi: int(body.rssi, -200, 0),
    firmware: text(body.fw, 20),
    failures: int(body.fails, 0, 1_000_000_000),
    lastError: int(body.err, -1000, 1000),
    resetReason: text(body.reset, 40),
    freeHeap: int(body.heap, 0, 100_000_000),
    ack: int(body.ack, 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };

  const result = await checkIn(token, report);
  if (!result) return Response.json({ ok: false, error: "unknown token" }, { status: 401 });

  return Response.json({
    ok: true,
    occupancy: result.occupancy,
    interval_ms: result.intervalMs,
    commands: result.commands,
  });
}
