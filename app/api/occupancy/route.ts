import { connection } from "next/server";
import { getPublicStatus } from "@/lib/tracker";

// Public: the live count. Cached at the CDN for a few seconds so a crowd of
// viewers costs one database read, not one each.
export async function GET() {
  await connection();
  const status = await getPublicStatus();
  return Response.json(status, {
    headers: { "Cache-Control": "public, s-maxage=3, stale-while-revalidate=10" },
  });
}
