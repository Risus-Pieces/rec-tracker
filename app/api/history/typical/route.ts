import { connection } from "next/server";
import { getTypicalWeek } from "@/lib/history";

// Public: the average count for each weekday and hour over the past weeks.
export async function GET() {
  await connection();
  return Response.json(await getTypicalWeek(), {
    headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=900" },
  });
}
