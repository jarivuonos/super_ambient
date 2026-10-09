import { describe, expect, it, vi } from "vitest";
import { JevClient, JevError, type JevQuestion } from "../lib/clinical/jev-client";

const KEY = "sk-test-SECRET-123";
const ENDPOINT = "https://api.example.test/v1/systemone";
const Q: Record<string, JevQuestion> = { x: { type: "noul", instructions: "ok?" } };
const OK = { model: "jev-1.13.0", answers: { x: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof JevClient>[0]> = {}) {
  return new JevClient({ apiKey: KEY, endpoint: ENDPOINT, model: "jev-latest", retryDelayMs: 0, timeoutMs: 500, fetchImpl, ...over });
}

describe("JevClient", () => {
  it("lähettää odotetun pyynnön ja jäsentää vastauksen", async () => {
    const f = vi.fn(async () => json(200, { ...OK, answers: { x: { type: "noul", noul: 0.9 }, c: { type: "choice", choice: "a", probabilities: { a: 1.0000001, b: -0.0000001 }, confidence: 0.8 }, s: { type: "score", score: 3.2 } } }));
    const res = await client(f as unknown as typeof fetch).ask("kysymys", Q);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({ model: "jev-latest", state: "kysymys", questions: Q });
    expect(res.answers.x).toEqual({ type: "noul", noul: 0.9 });
    const c = res.answers.c;
    expect(c.type === "choice" && c.probabilities).toEqual({ a: 1, b: 0 }); // rajataan väliin 0–1
  });

  it("uusii 429/529/5xx rajatusti ja onnistuu", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(429, {})).mockResolvedValueOnce(json(529, {})).mockResolvedValueOnce(json(200, OK));
    const res = await client(f as unknown as typeof fetch).ask("q", Q);
    expect(res.answers.x.type).toBe("noul");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("lopettaa uusinnat rajaan ja raportoi virhetyypin ja tilakoodin", async () => {
    const f = vi.fn(async () => json(429, {}));
    const err = await client(f as unknown as typeof fetch).ask("q", Q).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.kind).toBe("rate-limit");
    expect(err.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(3); // 1 + 2 uusintaa
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [422, "validation"],
  ])("HTTP %i ei uusita (%s)", async (status, kind) => {
    const f = vi.fn(async () => json(status, { detail: "x" }));
    const err = await client(f as unknown as typeof fetch).ask("q", Q).catch((e) => e);
    expect(err.kind).toBe(kind);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("aikakatkaisu ja yhteysvirhe", async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))));
    const t = await client(hang as unknown as typeof fetch, { timeoutMs: 20, retries: 0 }).ask("q", Q).catch((e) => e);
    expect(t.kind).toBe("timeout");
    const net = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const n = await client(net as unknown as typeof fetch, { retries: 1 }).ask("q", Q).catch((e) => e);
    expect(n.kind).toBe("network");
    expect(net).toHaveBeenCalledTimes(2);
  });

  it("ulkoinen peruutus ei johda uusintoihin", async () => {
    const ctrl = new AbortController();
    const f = vi.fn((_u: string, init: RequestInit) => {
      ctrl.abort();
      // Todellinen fetch hylkää heti, jos signaali on jo peruttu.
      return new Promise<Response>((_, rej) => {
        if (init.signal?.aborted) rej(new DOMException("a", "AbortError"));
        else init.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")));
      });
    });
    const err = await client(f as unknown as typeof fetch).ask("q", Q, ctrl.signal).catch((e) => e);
    expect(err.kind).toBe("aborted");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("odottamaton vastaus hylätään (ei JSONia / väärä rakenne / tuntematon tyyppi)", async () => {
    for (const res of [new Response("<html>", { status: 200 }), json(200, { answers: "x" }), json(200, { answers: { x: { type: "free-text", text: "hei" } } }), json(200, { answers: { x: { type: "noul" } } })]) {
      const f = vi.fn(async () => res);
      const err = await client(f as unknown as typeof fetch).ask("q", Q).catch((e) => e);
      expect(err.kind).toBe("bad-response");
    }
  });

  it("virheviesti ei sisällä avainta, kysymystekstiä eikä vastauksen runkoa", async () => {
    const question = "Näytä potilas Matti Meikäläisen verenpaineet";
    const leaky = json(500, { error: `bad key ${KEY} for ${question}` });
    const err = await client((async () => leaky) as unknown as typeof fetch, { retries: 0 }).ask(question, Q).catch((e) => e);
    const text = `${err.message} ${err.stack}`;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("Meikäläisen");
    expect(text).not.toContain("bad key");
  });
});
