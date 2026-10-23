import { isAdmin } from "@/lib/auth";
import {
  adjustCount,
  createDevice,
  deleteDevice,
  queueCalibrate,
  resetCount,
  rotateToken,
  setResetTime,
  setThresholds,
  updateDevice,
  type Role,
} from "@/lib/tracker";

const bad = (error: string) => Response.json({ error }, { status: 400 });
const isRole = (v: unknown): v is Role => v === "entrance" || v === "exit";
const cleanName = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 40) : "");
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

// Every button on the admin page posts here with { action, ... }.
export async function POST(request: Request) {
  if (!(await isAdmin())) return Response.json({ error: "signed_out" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.action !== "string") return bad("action is required");

  switch (body.action) {
    case "reset":
      await resetCount();
      return Response.json({ ok: true });

    case "adjust":
      if (body.delta !== 1 && body.delta !== -1) return bad("delta must be 1 or -1");
      await adjustCount(body.delta);
      return Response.json({ ok: true });

    case "calibrate":
      if (!isId(body.id)) return bad("id is required");
      await queueCalibrate(body.id);
      return Response.json({ ok: true });

    case "createDevice": {
      const name = cleanName(body.name);
      if (!name || !isRole(body.role)) return bad("name and role are required");
      return Response.json({ ok: true, ...(await createDevice(name, body.role)) });
    }

    case "updateDevice": {
      const name = cleanName(body.name);
      if (!isId(body.id) || !name || !isRole(body.role)) return bad("id, name and role are required");
      await updateDevice(body.id, name, body.role);
      return Response.json({ ok: true });
    }

    case "deleteDevice":
      if (!isId(body.id)) return bad("id is required");
      await deleteDevice(body.id);
      return Response.json({ ok: true });

    case "rotateToken": {
      if (!isId(body.id)) return bad("id is required");
      const token = await rotateToken(body.id);
      return token ? Response.json({ ok: true, token }) : bad("no such device");
    }

    case "setResetTime":
      if (typeof body.resetTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.resetTime)) {
        return bad("resetTime must be HH:MM");
      }
      await setResetTime(body.resetTime);
      return Response.json({ ok: true });

    case "setThresholds": {
      const { quietBelow, busyFrom } = body;
      const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000;
      if (!ok(quietBelow) || !ok(busyFrom) || quietBelow >= busyFrom) {
        return bad("quietBelow and busyFrom must be whole numbers, with quietBelow smaller");
      }
      await setThresholds(quietBelow, busyFrom);
      return Response.json({ ok: true });
    }

    default:
      return bad("unknown action");
  }
}
