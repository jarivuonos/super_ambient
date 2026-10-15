import { connection } from "next/server";
import { pkceCookieName, serializeCookie } from "@/lib/auth/session";
import { SmartAuthError, startLogin } from "@/lib/auth/smart";
import { findSource, resolveBaseUrl } from "@/lib/fhir/sources";
import { logError } from "@/lib/services";

/** Aloittaa SMART-kirjautumisen: asettaa PKCE-evästeen ja ohjaa lähteen kirjautumissivulle. */
export async function GET(request: Request, ctx: { params: Promise<{ source: string }> }) {
  await connection();
  const { source: id } = await ctx.params;
  const source = findSource(id);
  if (!source || source.auth.kind !== "smart-standalone") return new Response("Tuntematon lähde.", { status: 404 });
  const back = (code?: string) => new Response(null, { status: 302, headers: { Location: `/?source=${id}${code ? `&auth_error=${code}` : ""}` } });

  const clientId = process.env[source.auth.clientIdEnv]?.trim();
  if (!clientId) return back("not-configured");

  const origin = new URL(request.url).origin;
  try {
    const start = await startLogin({
      baseUrl: resolveBaseUrl(source, process.env),
      clientId,
      redirectUri: `${origin}/api/auth/${id}/callback`,
      scopes: source.auth.scopes,
    });
    const res = new Response(null, { status: 302, headers: { Location: start.location } });
    res.headers.append(
      "Set-Cookie",
      serializeCookie(pkceCookieName(id), start.pkceCookieValue, { maxAge: 600, path: `/api/auth/${id}`, secure: origin.startsWith("https:"), sameSite: "Lax" }),
    );
    return res;
  } catch (e) {
    logError("auth/login", e);
    return back(e instanceof SmartAuthError ? e.code : "discovery-failed");
  }
}
