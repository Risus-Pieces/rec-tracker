import { adminConfigured, passwordMatches, startSession } from "@/lib/auth";

export async function POST(request: Request) {
  if (!adminConfigured()) return Response.json({ error: "not_configured" }, { status: 503 });
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!passwordMatches(password)) {
    // Slows down password guessing.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return Response.json({ error: "wrong_password" }, { status: 401 });
  }
  await startSession();
  return Response.json({ ok: true });
}
