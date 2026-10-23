import { connection, type NextRequest } from "next/server";
import { getDaySeries } from "@/lib/history";

// Public: the count through one day. ?date=YYYY-MM-DD, Rec local time; defaults to today.
export async function GET(request: NextRequest) {
  await connection();
  const date = request.nextUrl.searchParams.get("date");
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const day = await getDaySeries(date ?? todayLocal);
  // A finished day never changes again; today does.
  const finished = day.date < day.today;
  return Response.json(day, {
    headers: { "Cache-Control": `public, s-maxage=${finished ? 3600 : 60}, stale-while-revalidate=60` },
  });
}
