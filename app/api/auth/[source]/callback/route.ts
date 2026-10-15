import { connection } from "next/server";
import { clearCookie, encodeSession, MAX_COOKIE_VALUE, parseCookies, pkceCookieName, serializeCookie, tokenCookieName } from "@/lib/auth/session";
import { finishLogin, SmartAuthError } from "@/lib/auth/smart";
import { findSource, resolveBaseUrl } from "@/lib/fhir/sources";
import { logError } from "@/lib/services";

/** Vastaanottaa kirjautumispalvelimen paluun, vaihtaa koodin pääsytunnisteeksi ja tallentaa sen httpOnly-evästeeseen. */
export async function GET(request: Request, ctx: { params: Promise<{ source: string }> }) {
  await connection();
  const { source: id } = await ctx.params;
  const source = findSource(id);
  if (!source || source.auth.kind !== "smart-standalone") return new Response("Tuntematon lähde.", { status: 404 });

  const url = new URL(request.url);
  const secure = url.origin.startsWith("https:");
  const pkce = parseCookies(request.headers.get("cookie"))[pkceCookieName(id)];
  const done = (code?: string) => {
    const res = new Response(null, { status: 302, headers: { Location: `/?source=${id}${code ? `&auth_error=${code}` : ""}` } });
    res.headers.append("Set-Cookie", clearCookie(pkceCookieName(id), { path: `/api/auth/${id}`, secure, sameSite: "Lax" }));
    return res;
  };

  const clientId = process.env[source.auth.clientIdEnv]?.trim();
  if (!clientId) return done("not-configured");
  try {
    const token = await finishLogin({
      baseUrl: resolveBaseUrl(source, process.env),
      clientId,
      redirectUri: `${url.origin}/api/auth/${id}/callback`,
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      providerError: url.searchParams.get("error"),
      pkceCookieValue: pkce,
    });
    const value = encodeSession(token);
    if (value.length > MAX_COOKIE_VALUE) return done("bad-response");
    const res = done();
    res.headers.append(
      "Set-Cookie",
      serializeCookie(tokenCookieName(id), value, { maxAge: (token.expiresAt - Date.now()) / 1000, path: "/api", secure, sameSite: "Strict" }),
    );
    return res;
  } catch (e) {
    if (!(e instanceof SmartAuthError) || e.code !== "denied") logError("auth/callback", e);
    return done(e instanceof SmartAuthError ? e.code : "token-failed");
  }
}
