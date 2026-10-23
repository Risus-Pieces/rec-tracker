import { connection } from "next/server";
import { getDailyPeaks } from "@/lib/history";

// Public: every day so far with its busiest moment, newest first.
export async function GET() {
  await connection();
  return Response.json(await getDailyPeaks(), {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" },
  });
}
