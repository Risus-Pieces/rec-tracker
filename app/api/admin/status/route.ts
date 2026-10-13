import { adminConfigured, isAdmin } from "@/lib/auth";
import { getAdminStatus } from "@/lib/tracker";

export async function GET() {
  if (!adminConfigured()) return Response.json({ error: "not_configured" }, { status: 503 });
  if (!(await isAdmin())) return Response.json({ error: "signed_out" }, { status: 401 });
  return Response.json(await getAdminStatus(), { headers: { "Cache-Control": "no-store" } });
}
