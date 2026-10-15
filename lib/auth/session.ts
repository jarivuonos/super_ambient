import { z } from "zod";

// Istunto on httpOnly-eväste, jossa on pääsytunniste. Selaimen JavaScript ei näe sitä; vain
// sovelluksen palvelin lukee sen. Ei palvelimen muistia (toimii Vercelissä) eikä salaisuuksia.
// Ei `server-only`: testattavissa.

export const tokenCookieName = (sourceId: string) => `sa_tok_${sourceId}`;
export const pkceCookieName = (sourceId: string) => `sa_pkce_${sourceId}`;

/** Selaimen eväste on enintään ~4096 tavua; jätetään reunaa. */
export const MAX_COOKIE_VALUE = 3800;
const SKEW_MS = 30_000;

export const SessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number(),
});
export type TokenSession = z.infer<typeof SessionSchema>;

export function encodeSession(s: TokenSession): string {
  return Buffer.from(JSON.stringify({ accessToken: s.accessToken, expiresAt: s.expiresAt })).toString("base64url");
}

export function decodeSession(raw: string | undefined, now = Date.now()): TokenSession | null {
  if (!raw) return null;
  try {
    const parsed = SessionSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.expiresAt - SKEW_MS <= now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionFromRequest(request: Request, sourceId: string, now = Date.now()): TokenSession | null {
  return decodeSession(parseCookies(request.headers.get("cookie"))[tokenCookieName(sourceId)], now);
}

export interface CookieOptions {
  maxAge: number;
  path: string;
  secure: boolean;
  /** Token: Strict. PKCE-eväste: Lax, koska se palaa kirjautumispalvelimen uudelleenohjauksessa. */
  sameSite: "Strict" | "Lax";
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(o.maxAge))}; Path=${o.path}; HttpOnly; SameSite=${o.sameSite}${o.secure ? "; Secure" : ""}`;
}

export function clearCookie(name: string, o: Omit<CookieOptions, "maxAge">): string {
  return serializeCookie(name, "", { ...o, maxAge: 0 });
}
