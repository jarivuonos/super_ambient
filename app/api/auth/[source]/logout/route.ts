import { clearCookie, tokenCookieName } from "@/lib/auth/session";
import { findSource } from "@/lib/fhir/sources";

/** Poistaa selaimesta lähteen pääsytunnisteen. Tunnistepalvelimelle ei tehdä kutsua. */
export async function POST(request: Request, ctx: { params: Promise<{ source: string }> }) {
  const { source: id } = await ctx.params;
  const source = findSource(id);
  if (!source || source.auth.kind === "none") return new Response("Tuntematon lähde.", { status: 404 });
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", clearCookie(tokenCookieName(id), { path: "/api", secure: new URL(request.url).origin.startsWith("https:"), sameSite: "Strict" }));
  return res;
}
