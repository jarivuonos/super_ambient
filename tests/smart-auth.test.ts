import { beforeEach, describe, expect, it } from "vitest";
import { codeChallenge, randomToken } from "@/lib/auth/pkce";
import { clearCookie, decodeSession, encodeSession, parseCookies, serializeCookie, sessionFromRequest, tokenCookieName } from "@/lib/auth/session";
import { AUTH_ERROR_MESSAGES } from "@/lib/auth/errors";
import { SmartAuthError, buildAuthorizeUrl, clearDiscoveryCache, discoverEndpoints, finishLogin, startLogin } from "@/lib/auth/smart";
import { HapiR4Adapter } from "@/lib/fhir/hapi-adapter";
import { SOURCES } from "@/lib/fhir/sources";

const BASE = "https://fhir.example.org/interconnect/api/FHIR/R4";
const AUTHORIZE = "https://fhir.example.org/interconnect/oauth2/authorize";
const TOKEN = "https://fhir.example.org/interconnect/oauth2/token";
const SECRET_TOKEN = "tok-SECRET-abc123";

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeServer(opts: { tokenStatus?: number; tokenBody?: unknown; endpoints?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/.well-known/smart-configuration")) {
      return Response.json(opts.endpoints ?? { authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN });
    }
    if (u === TOKEN) {
      return Response.json(opts.tokenBody ?? { access_token: SECRET_TOKEN, token_type: "Bearer", expires_in: 3600 }, { status: opts.tokenStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => clearDiscoveryCache());

describe("PKCE", () => {
  it("code_challenge täsmää RFC 7636 -liitteen B esimerkkiin", async () => {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("satunnaiset tunnisteet ovat URL-turvallisia ja erilaisia", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
});

describe("kirjautumisosoitteet", () => {
  it("löytyvät smart-configurationista ja välimuistitetaan", async () => {
    const s = fakeServer();
    expect(await discoverEndpoints(BASE, s.fetchImpl)).toEqual({ authorize: AUTHORIZE, token: TOKEN });
    await discoverEndpoints(BASE, s.fetchImpl);
    expect(s.calls).toHaveLength(1);
  });
  it("hylkää osoitteet, jotka eivät ole palvelimen omalla originilla", async () => {
    const s = fakeServer({ endpoints: { authorization_endpoint: AUTHORIZE, token_endpoint: "https://evil.example/token" } });
    await expect(discoverEndpoints(BASE, s.fetchImpl)).rejects.toMatchObject({ code: "discovery-failed" });
  });
});

describe("kirjautumisen aloitus", () => {
  it("authorize-osoite sisältää PKCE S256:n, aud:n ja tilan, mutta ei salaisuutta eikä verifieria", async () => {
    const s = fakeServer();
    const start = await startLogin({ baseUrl: BASE, clientId: "cid-1", redirectUri: "http://localhost:3000/api/auth/epic/callback", scopes: ["openid", "fhirUser"], fetchImpl: s.fetchImpl });
    const u = new URL(start.location);
    expect(`${u.origin}${u.pathname}`).toBe(AUTHORIZE);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cid-1");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/epic/callback");
    expect(u.searchParams.get("scope")).toBe("openid fhirUser");
    expect(u.searchParams.get("aud")).toBe(BASE);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const [state, verifier] = start.pkceCookieValue.split(".");
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("code_challenge")).toBe(await codeChallenge(verifier));
    expect(start.location).not.toContain(verifier);
    expect(start.location).not.toMatch(/client_secret/);
  });
  it("buildAuthorizeUrl koodaa parametrit", () => {
    const url = buildAuthorizeUrl({ authorizeEndpoint: AUTHORIZE, clientId: "a b", redirectUri: "http://x/cb?y=1", scopes: ["openid"], state: "s", challenge: "c", audience: BASE });
    expect(new URL(url).searchParams.get("client_id")).toBe("a b");
  });
});

describe("kirjautumisen päätös", () => {
  const base = { baseUrl: BASE, clientId: "cid-1", redirectUri: "http://localhost:3000/api/auth/epic/callback" };

  it("vaihtaa koodin tunnisteeksi julkisena asiakkaana (verifier mukana, ei client_secretiä)", async () => {
    const s = fakeServer();
    const t = await finishLogin({ ...base, code: "code-1", state: "st", providerError: null, pkceCookieValue: "st.ver-1", fetchImpl: s.fetchImpl, now: () => 1_000_000 });
    expect(t).toMatchObject({ accessToken: SECRET_TOKEN, expiresAt: 1_000_000 + 3600_000 });
    const body = new URLSearchParams(String(s.calls.find((c) => c.url === TOKEN)!.init!.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: "authorization_code", code: "code-1", redirect_uri: base.redirectUri, client_id: "cid-1", code_verifier: "ver-1" });
  });

  it("hylkää väärän tai puuttuvan tilan ilman tunnistepyyntöä", async () => {
    const s = fakeServer();
    for (const [state, cookie] of [["x", "st.ver"], [null, "st.ver"], ["st", undefined], ["st", "st"]] as const) {
      await expect(finishLogin({ ...base, code: "c", state, providerError: null, pkceCookieValue: cookie, fetchImpl: s.fetchImpl })).rejects.toMatchObject({ code: "state-mismatch" });
    }
    expect(s.calls.some((c) => c.url === TOKEN)).toBe(false);
  });

  it("lähteen virhe (error=access_denied) tulkitaan keskeytykseksi", async () => {
    await expect(finishLogin({ ...base, code: null, state: "st", providerError: "access_denied", pkceCookieValue: "st.v" })).rejects.toMatchObject({ code: "denied" });
  });

  it("virheet kantavat vain kiinteän viestin: ei vastausta, koodia, verifieria eikä tunnistetta", async () => {
    const s = fakeServer({ tokenStatus: 400, tokenBody: { error: "invalid_grant", error_description: `leak ${SECRET_TOKEN} code-1 ver-1` } });
    const err = await finishLogin({ ...base, code: "code-1", state: "st", providerError: null, pkceCookieValue: "st.ver-1", fetchImpl: s.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SmartAuthError);
    expect(err.message).toBe(AUTH_ERROR_MESSAGES["token-failed"]);
    expect(err.status).toBe(400);
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toMatch(/SECRET|code-1|ver-1|leak/);
  });

  it("hylkää muun kuin Bearer-tunnisteen ja puutteellisen vastauksen", async () => {
    for (const tokenBody of [{ access_token: "t", token_type: "mac" }, { token_type: "Bearer" }, "ei-olio"]) {
      clearDiscoveryCache();
      const s = fakeServer({ tokenBody });
      await expect(finishLogin({ ...base, code: "c", state: "st", providerError: null, pkceCookieValue: "st.v", fetchImpl: s.fetchImpl })).rejects.toMatchObject({ code: "bad-response" });
    }
  });
});

describe("istuntoeväste", () => {
  const now = 1_000_000;
  const good = { accessToken: SECRET_TOKEN, expiresAt: now + 600_000 };

  it("pyörähtää ympäri ja vanhentunut, rikki tai väärän muotoinen hylätään", () => {
    expect(decodeSession(encodeSession(good), now)).toEqual(good);
    expect(decodeSession(encodeSession({ ...good, expiresAt: now + 10_000 }), now)).toBeNull(); // alle 30 s jäljellä
    expect(decodeSession(encodeSession({ ...good, expiresAt: now - 1 }), now)).toBeNull();
    expect(decodeSession("%%%ei-base64", now)).toBeNull();
    expect(decodeSession(Buffer.from('{"accessToken":""}').toString("base64url"), now)).toBeNull();
    expect(decodeSession(undefined, now)).toBeNull();
  });

  it("luetaan pyynnön Cookie-otsakkeesta lähdekohtaisesti", () => {
    const req = new Request("http://x/api/ask", { headers: { cookie: `a=1; ${tokenCookieName("epic")}=${encodeSession(good)}; b=2` } });
    expect(sessionFromRequest(req, "epic", now)).toEqual(good);
    expect(sessionFromRequest(req, "hapi", now)).toBeNull();
    expect(parseCookies("a=1; b=x=y")).toEqual({ a: "1", b: "x=y" });
  });

  it("eväste on httpOnly ja SameSite; Secure vain https:ssä; poisto nollaa iän", () => {
    const c = serializeCookie("n", "v", { maxAge: 60.9, path: "/api", secure: true, sameSite: "Strict" });
    expect(c).toBe("n=v; Max-Age=60; Path=/api; HttpOnly; SameSite=Strict; Secure");
    expect(serializeCookie("n", "v", { maxAge: 5, path: "/", secure: false, sameSite: "Lax" })).not.toContain("Secure");
    expect(clearCookie("n", { path: "/api", secure: false, sameSite: "Strict" })).toContain("Max-Age=0");
  });
});

describe("pääsytunniste FHIR-pyynnöissä", () => {
  it("Bearer lähtee palvelimelle; ilman tunnistetta ei Authorization-otsaketta", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      seen.push(init!.headers as Record<string, string>);
      return Response.json({ resourceType: "Bundle", type: "searchset", entry: [] });
    }) as unknown as typeof fetch;
    await new HapiR4Adapter({ baseUrl: BASE, fetchImpl, accessToken: SECRET_TOKEN }).findByIdentifier("Patient", "s", "v");
    await new HapiR4Adapter({ baseUrl: BASE, fetchImpl }).findByIdentifier("Patient", "s", "v");
    expect(seen[0].Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(seen[1].Authorization).toBeUndefined();
  });
});

describe("rekisterin kirjautumissäännöt", () => {
  it("kirjoitettava lähde ei vaadi kirjautumista (käyttäjäkohtaista kirjoitusta ei ole toteutettu)", () => {
    for (const s of SOURCES.filter((x) => x.writable)) expect(s.auth.kind).toBe("none");
  });
  it("kirjautumista vaativan lähteen osoite on https ja asiakastunnus tulee ympäristömuuttujasta", () => {
    for (const s of SOURCES.filter((x) => x.auth.kind !== "none")) {
      expect(s.baseUrl.startsWith("https://")).toBe(true);
      if (s.auth.kind === "smart-standalone") expect(s.auth.clientIdEnv).toMatch(/^[A-Z0-9_]+$/);
    }
  });
});
