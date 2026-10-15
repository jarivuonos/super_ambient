import { z } from "zod";
import { SmartAuthError } from "./errors";
import { codeChallenge, randomToken } from "./pkce";

export { SmartAuthError } from "./errors";

// SMART on FHIR -tunnistautuminen: standalone launch, julkinen asiakas (ei salaisuutta), PKCE S256.
// Ei `server-only`: fetch on injektoitavissa ja moduuli testattavissa. Virheet kantavat vain kiinteän
// koodin ja HTTP-tilan, eivät palvelimen vastausta, koodeja eivätkä tokeneita.

export interface SmartEndpoints {
  authorize: string;
  token: string;
}

const DiscoverySchema = z.object({ authorization_endpoint: z.string(), token_endpoint: z.string() });
const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  patient: z.string().optional(),
});

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; endpoints: SmartEndpoints }>();

/** Hakee kirjautumisosoitteet palvelimen .well-known/smart-configuration-tiedosta. Osoitteiden on oltava palvelimen omalla originilla. */
export async function discoverEndpoints(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<SmartEndpoints> {
  const cached = discoveryCache.get(baseUrl);
  if (cached && now() - cached.at < DISCOVERY_TTL_MS) return cached.endpoints;
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/.well-known/smart-configuration`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SmartAuthError("discovery-failed");
  }
  if (!res.ok) throw new SmartAuthError("discovery-failed", res.status);
  const parsed = DiscoverySchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new SmartAuthError("discovery-failed");
  const origin = new URL(baseUrl).origin;
  try {
    const a = new URL(parsed.data.authorization_endpoint);
    const t = new URL(parsed.data.token_endpoint);
    if (a.origin !== origin || t.origin !== origin) throw new Error("origin");
  } catch {
    throw new SmartAuthError("discovery-failed");
  }
  const endpoints = { authorize: parsed.data.authorization_endpoint, token: parsed.data.token_endpoint };
  discoveryCache.set(baseUrl, { at: now(), endpoints });
  return endpoints;
}

export function clearDiscoveryCache() {
  discoveryCache.clear();
}

export function buildAuthorizeUrl(p: {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
  /** FHIR-palvelimen osoite (SMART `aud`). */
  audience: string;
}): string {
  const u = new URL(p.authorizeEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", p.scopes.join(" "));
  u.searchParams.set("state", p.state);
  u.searchParams.set("aud", p.audience);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface LoginStart {
  location: string;
  /** Tallennetaan lyhytaikaiseen evästeeseen: `state.verifier`. */
  pkceCookieValue: string;
}

export async function startLogin(p: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  fetchImpl?: typeof fetch;
}): Promise<LoginStart> {
  const endpoints = await discoverEndpoints(p.baseUrl, p.fetchImpl);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const location = buildAuthorizeUrl({
    authorizeEndpoint: endpoints.authorize,
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    scopes: p.scopes,
    state,
    challenge: await codeChallenge(verifier),
    audience: p.baseUrl,
  });
  return { location, pkceCookieValue: `${state}.${verifier}` };
}

export interface TokenResult {
  accessToken: string;
  expiresAt: number;
  patient?: string;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function finishLogin(p: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  /** Epicin paluuparametrit. */
  code: string | null;
  state: string | null;
  providerError: string | null;
  pkceCookieValue: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<TokenResult> {
  const now = p.now ?? Date.now;
  if (p.providerError) throw new SmartAuthError("denied");
  const [state, verifier] = (p.pkceCookieValue ?? "").split(".");
  if (!p.code || !p.state || !state || !verifier || !safeEqual(p.state, state)) throw new SmartAuthError("state-mismatch");
  const endpoints = await discoverEndpoints(p.baseUrl, p.fetchImpl, now);
  let res: Response;
  try {
    res = await (p.fetchImpl ?? fetch)(endpoints.token, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: p.code,
        redirect_uri: p.redirectUri,
        client_id: p.clientId,
        code_verifier: verifier,
      }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SmartAuthError("token-failed");
  }
  if (!res.ok) throw new SmartAuthError("token-failed", res.status);
  const parsed = TokenSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") throw new SmartAuthError("bad-response");
  const seconds = Math.min(parsed.data.expires_in ?? 300, 24 * 3600);
  return { accessToken: parsed.data.access_token, expiresAt: now() + seconds * 1000, patient: parsed.data.patient };
}
