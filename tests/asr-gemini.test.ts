import { describe, expect, it } from "vitest";
import { engineFor, GeminiError, GeminiTranscriber, parseInteraction, parseSpeakerLines, transcriptionPrompt } from "../lib/transcription/gemini-client";

const KEY = "SECRET-KEY-123";
const HOST = "https://generativelanguage.googleapis.com";
const UPLOAD = `${HOST}/upload/v1beta/files/abc?upload_id=1`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

const INTERACTION = {
  output_text: "Hei, miten voit?",
  steps: [{ content: [{ text: "Hei, miten voit?", annotations: [{ type: "word_info", text: "Hei", speaker: "spk_1", start_offset: "0s", end_offset: "0.4s" }, { type: "word_info", text: "miten", speaker: "spk_2", start_offset: "0.5s", end_offset: "0.9s" }] }] }],
};

function fake(over: { uploadUrl?: string | null; interactions?: () => Response } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, method: init?.method ?? "GET", headers, body: init?.body as Call["body"] });
    if (u === `${HOST}/upload/v1beta/files`) {
      const h: Record<string, string> = {};
      const url2 = over.uploadUrl === undefined ? UPLOAD : over.uploadUrl;
      if (url2) h["x-goog-upload-url"] = url2;
      return new Response("{}", { status: 200, headers: h });
    }
    if (u === UPLOAD) return Response.json({ file: { uri: `${HOST}/v1beta/files/abc`, name: "files/abc" } });
    if (u === `${HOST}/v1beta/files/abc` && init?.method === "DELETE") return Response.json({});
    if (u === `${HOST}/v1beta/files/abc`) return Response.json({ name: "files/abc", state: "ACTIVE" });
    if (u === `${HOST}/v1beta/interactions`) return over.interactions ? over.interactions() : Response.json(INTERACTION);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const make = (f: ReturnType<typeof fake>, extra: Partial<ConstructorParameters<typeof GeminiTranscriber>[0]> = {}) =>
  new GeminiTranscriber({ apiKey: KEY, model: "gemini-3.5-transcribe", fetchImpl: f.fetchImpl, sleep: async () => undefined, ...extra });

describe("Gemini-asiakas (kuvitellulla verkolla)", () => {
  it("koko ketju: lataus, valmiuden odotus, litterointi ja poisto; avain vain Googlen pyynnöissä, ei lopullisessa latauksessa", async () => {
    const f = fake();
    const r = await make(f).transcribeBytes(new Uint8Array([1, 2, 3]), "audio/ogg", "asr-test-x", { languageCodes: ["fi-FI"], diarize: true, timestamps: false });
    expect(r.text).toBe("Hei, miten voit?");
    expect(r.words.map((w) => [w.text, w.speaker])).toEqual([["Hei", "spk_1"], ["miten", "spk_2"]]);

    const start = f.calls[0];
    expect(start.headers["x-goog-api-key"]).toBe(KEY);
    expect(start.headers["X-Goog-Upload-Command"]).toBe("start");
    expect(start.headers["X-Goog-Upload-Header-Content-Length"]).toBe("3");
    expect(start.headers["X-Goog-Upload-Header-Content-Type"]).toBe("audio/ogg");
    expect(JSON.parse(start.body as string)).toEqual({ file: { display_name: "asr-test-x" } });

    const finalize = f.calls.find((c) => c.url === UPLOAD)!;
    expect(finalize.headers["x-goog-api-key"]).toBeUndefined();
    expect(finalize.headers["X-Goog-Upload-Command"]).toBe("upload, finalize");

    const inter = f.calls.find((c) => c.url.endsWith("/interactions"))!;
    expect(inter.headers["x-goog-api-key"]).toBe(KEY);
    expect(JSON.parse(inter.body as string)).toEqual({
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", uri: `${HOST}/v1beta/files/abc`, mime_type: "audio/ogg" }],
      generation_config: { transcription_config: { language_codes: ["fi-FI"], mode: { type: "verbatim", diarization_mode: "speaker" } } },
    });

    const del = f.calls[f.calls.length - 1];
    expect([del.method, del.url]).toEqual(["DELETE", `${HOST}/v1beta/files/abc`]);
  });

  it("tavallinen tila ei lähetä mode-asetusta; aikaleimat lisäävät sanatason aikaleimat", async () => {
    const plain = fake();
    await make(plain).transcribeBytes(new Uint8Array([1]), "audio/ogg", "x", { languageCodes: ["sv-SE"], diarize: false, timestamps: false });
    const body = JSON.parse(plain.calls.find((c) => c.url.endsWith("/interactions"))!.body as string);
    expect(body.generation_config.transcription_config).toEqual({ language_codes: ["sv-SE"] });

    const ts = fake();
    await make(ts).transcribeBytes(new Uint8Array([1]), "audio/ogg", "x", { languageCodes: ["fi-FI"], diarize: false, timestamps: true });
    const body2 = JSON.parse(ts.calls.find((c) => c.url.endsWith("/interactions"))!.body as string);
    expect(body2.generation_config.transcription_config.mode).toEqual({ type: "verbatim", timestamp_granularities: ["word"] });
  });

  it("latausosoite muulla palvelimella hylätään eikä äänitavuja lähetetä sinne", async () => {
    const f = fake({ uploadUrl: "https://evil.example/upload" });
    await expect(make(f).upload(new Uint8Array([9, 9]), "audio/ogg", "x")).rejects.toThrow(/ei ollut Googlen palvelimella/);
    expect(f.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
    const g = fake({ uploadUrl: null });
    await expect(make(g).upload(new Uint8Array([9]), "audio/ogg", "x")).rejects.toThrow(GeminiError);
  });

  it("429: odottaa Retry-After-ajan ja yrittää uudelleen", async () => {
    let n = 0;
    const waits: number[] = [];
    const f = fake({ interactions: () => (++n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "7" } }) : Response.json(INTERACTION)) });
    const r = await make(f, { sleep: async (ms) => void waits.push(ms) }).transcribeBytes(new Uint8Array([1]), "audio/ogg", "x", { languageCodes: ["fi-FI"], diarize: false, timestamps: false });
    expect(r.text).toBeTruthy();
    expect(waits).toContain(7000);
  });

  it("virheviesti ei sisällä avainta, ja ladattu tiedosto poistetaan silti", async () => {
    const f = fake({ interactions: () => Response.json({ error: { message: `Bad request for key ${KEY}` } }, { status: 400 }) });
    const err = await make(f).transcribeBytes(new Uint8Array([1]), "audio/ogg", "x", { languageCodes: ["fi-FI"], diarize: false, timestamps: false }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.status).toBe(400);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("***");
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("vastauksen jäsennys: askelten teksti käy, kun output_text puuttuu; tyhjä vastaus on virhe", () => {
    const r = parseInteraction({ steps: [{ content: [{ text: "Moi" }, { text: " maailma" }] }] });
    expect(r.text).toBe("Moi maailma");
    expect(r.words).toEqual([]);
    expect(() => parseInteraction({ steps: [] })).toThrow(/ei löytynyt tekstiä/);
    expect(() => parseInteraction("ei olio")).toThrow(GeminiError);
  });
});

describe("uusintojen näkyvyys", () => {
  it("onRetry kutsutaan jokaisella odotuksella tilakoodin ja ajan kanssa; viimeinen epäonnistuminen kertoo virheen", async () => {
    const infos: { status?: number; waitMs: number; attempt: number; maxRetries: number }[] = [];
    const f = fake({ interactions: () => new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 }) });
    const err = await make(f, { maxRetries: 2, onRetry: (i) => void infos.push(i) })
      .transcribeBytes(new Uint8Array([1]), "audio/ogg", "x", { languageCodes: ["fi-FI"], diarize: false, timestamps: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.status).toBe(503);
    expect(err.message).toContain("high demand");
    expect(infos).toEqual([
      { status: 503, waitMs: 2000, attempt: 1, maxRetries: 2 },
      { status: 503, waitMs: 4000, attempt: 2, maxRetries: 2 },
    ]);
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("yleismalli kehotteella", () => {
  const PROMPT_REPLY = { output_text: "Speaker 1: Mikä tuo tänään vastaanotolle?\nSpeaker 2: Vatsakipua, ei kuumetta.\n**Speaker 1:** Onko ollut pahoinvointia?" };
  const file = { uri: `${HOST}/v1beta/files/abc`, mimeType: "audio/ogg" };

  it("moottori valitaan mallin nimestä; erillinen litterointimalli säilyy oletuksena", () => {
    expect(engineFor("gemini-3.5-transcribe")).toBe("transcribe");
    expect(engineFor("gemini-3.8-flash")).toBe("prompt");
    expect(make(fake(), { model: "gemini-3.8-flash" }).engine).toBe("prompt");
    expect(make(fake()).engine).toBe("transcribe");
  });

  it("pyyntö: tekstikehote ja ääni, ei transcription_config-asetuksia; kehote nimeää kielen ja kieltosanat", async () => {
    const f = fake({ interactions: () => Response.json({ output_text: "Vatsakipua, ei kuumetta." }) });
    const r = await make(f, { model: "gemini-3.8-flash" }).transcribe(file, { languageCodes: ["fi-FI"], diarize: false, timestamps: false });
    const body = JSON.parse(f.calls.find((c) => c.url.endsWith("/interactions"))!.body as string);
    expect(body.model).toBe("gemini-3.8-flash");
    expect(body.generation_config).toBeUndefined();
    expect(body.input[0].type).toBe("text");
    expect(body.input[0].text).toContain("Finnish");
    expect(body.input[0].text).toContain('"ei"');
    expect(body.input[0].text).not.toContain("Speaker 1");
    expect(body.input[1]).toEqual({ type: "audio", uri: file.uri, mime_type: "audio/ogg" });
    expect(r.text).toBe("Vatsakipua, ei kuumetta.");
    expect(r.words).toEqual([]);
  });

  it("puhujien erottelu pyydetään kehotteella ja rivit jäsentyvät sanoiksi puhujineen (myös lihavoidut tunnisteet)", async () => {
    const f = fake({ interactions: () => Response.json(PROMPT_REPLY) });
    const r = await make(f, { model: "gemini-3.8-flash" }).transcribe(file, { languageCodes: ["sv-SE"], diarize: true, timestamps: false });
    const body = JSON.parse(f.calls.find((c) => c.url.endsWith("/interactions"))!.body as string);
    expect(body.input[0].text).toContain("Swedish");
    expect(body.input[0].text).toContain("Speaker 1:");
    expect(r.words.filter((w) => w.speaker === "spk_1").map((w) => w.text).join(" ")).toBe("Mikä tuo tänään vastaanotolle? Onko ollut pahoinvointia?");
    expect(r.words.filter((w) => w.speaker === "spk_2").map((w) => w.text).join(" ")).toBe("Vatsakipua, ei kuumetta.");
    expect(r.words.some((w) => /speaker/i.test(w.text))).toBe(false);
  });

  it("rivit ilman puhujatunnisteita eivät tuota puhujatietoa; tuntematon vastausmuoto luetaan outputs-listasta", () => {
    expect(parseSpeakerLines("Vain tekstiä\nEi tunnisteita")).toEqual([]);
    expect(parseSpeakerLines("Puhuja A: moi")).toEqual([{ text: "moi", speaker: "spk_a" }]);
    const r = parseInteraction({ outputs: [{ content: [{ text: "Moi vaan" }] }] });
    expect(r.text).toBe("Moi vaan");
  });
});

describe("numerot numeroina (--digits)", () => {
  const file = { uri: `${HOST}/v1beta/files/abc`, mimeType: "audio/ogg" };

  it("kehote pyytää numeroita vain, kun valinta on päällä; erottelupyyntö säilyy mukana", () => {
    expect(transcriptionPrompt(["fi-FI"], false)).not.toMatch(/digits/);
    const d = transcriptionPrompt(["fi-FI"], false, true);
    expect(d).toContain("as digits");
    expect(d).toContain("never spelled out as words");
    const both = transcriptionPrompt(["sv-SE"], true, true);
    expect(both).toContain("as digits");
    expect(both).toContain("Speaker 1:");
    expect(both).toContain("Swedish");
  });

  it("yleismallin pyyntöön kehote tulee mukaan; erillisen litterointimallin pyyntö ei muutu", async () => {
    const p = fake({ interactions: () => Response.json({ output_text: "Syke 78." }) });
    await make(p, { model: "gemini-3.8-flash" }).transcribe(file, { languageCodes: ["fi-FI"], diarize: false, timestamps: false, digits: true });
    const prompt = JSON.parse(p.calls.find((c) => c.url.endsWith("/interactions"))!.body as string).input[0].text;
    expect(prompt).toContain("as digits");

    const a = fake();
    const b = fake();
    await make(a).transcribe(file, { languageCodes: ["fi-FI"], diarize: false, timestamps: false });
    await make(b).transcribe(file, { languageCodes: ["fi-FI"], diarize: false, timestamps: false, digits: true });
    const body = (f: ReturnType<typeof fake>) => f.calls.find((c) => c.url.endsWith("/interactions"))!.body;
    expect(body(b)).toBe(body(a));
  });
});

describe("kiintiövirheet", () => {
  it("päiväkiintiö (429, 'per day') ei käynnistä uusintoja eikä odotusta; viesti kertoo palautumisajan", async () => {
    let waits = 0;
    let retries = 0;
    const f = fake({ interactions: () => Response.json({ error: { message: "Rate limit exceeded (limit: 10 requests per day on Free Tier). Please retry in 23h19m47s." } }, { status: 429 }) });
    const err = await make(f, { sleep: async () => void waits++, onRetry: () => void retries++ })
      .transcribe({ uri: `${HOST}/v1beta/files/abc`, mimeType: "audio/ogg" }, { languageCodes: ["fi-FI"], diarize: false, timestamps: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.status).toBe(429);
    expect(err.message).toContain("23h19m47s");
    expect([waits, retries]).toEqual([0, 0]);
    expect(f.calls.filter((c) => c.url.endsWith("/interactions"))).toHaveLength(1);
  });

  it("minuuttikohtainen 429 yritetään edelleen uudelleen", async () => {
    let n = 0;
    let retries = 0;
    const f = fake({ interactions: () => (++n === 1 ? Response.json({ error: { message: "Too many requests per minute" } }, { status: 429 }) : Response.json(INTERACTION)) });
    const r = await make(f, { onRetry: () => void retries++ }).transcribe({ uri: `${HOST}/v1beta/files/abc`, mimeType: "audio/ogg" }, { languageCodes: ["fi-FI"], diarize: false, timestamps: false });
    expect(r.text).toBeTruthy();
    expect(retries).toBe(1);
  });
});

describe("vaiheiden aikamittaus", () => {
  const file = (n = 3) => new Uint8Array(n);
  const opts = { languageCodes: ["fi-FI"], diarize: false, timestamps: false };

  it("onnistunut ketju: kaikki vaiheet mitataan, kokonaisaika kattaa vaiheet, uusintojen odotus ja määrä kirjataan", async () => {
    let n = 0;
    const seen: unknown[] = [];
    const f = fake({ interactions: () => (++n === 1 ? new Response("{}", { status: 503, headers: { "retry-after": "7" } }) : Response.json(INTERACTION)) });
    const r = await make(f, { onTimings: (t) => void seen.push(t) }).transcribeBytes(file(5), "audio/ogg", "x", opts);
    const t = r.timings!;
    expect(t.audioBytes).toBe(5);
    expect(t.retries).toBe(1);
    expect(t.retryWaitMs).toBe(7000);
    for (const k of ["uploadMs", "activeMs", "transcribeMs", "deleteMs", "totalMs"] as const) expect(t[k]).toBeGreaterThanOrEqual(0);
    expect(t.totalMs + 1).toBeGreaterThanOrEqual(t.uploadMs + t.activeMs + t.transcribeMs + t.deleteMs);
    expect(seen).toEqual([t]);
  });

  it("virhe litteroinnissa: ajat annetaan silti, uusinnat kirjataan ja tiedosto poistetaan", async () => {
    const seen: { retries: number; deleteMs: number; transcribeMs: number }[] = [];
    const f = fake({ interactions: () => new Response(JSON.stringify({ error: { message: "kiire" } }), { status: 503 }) });
    const err = await make(f, { maxRetries: 2, onTimings: (t) => void seen.push(t) }).transcribeBytes(file(), "audio/ogg", "x", opts).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(seen).toHaveLength(1);
    expect(seen[0].retries).toBe(2);
    expect(seen[0].transcribeMs).toBeGreaterThanOrEqual(0);
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("virhe jo latauksessa: aika kirjataan latauksen piikkiin, litterointia ei yritetty eikä poistettavaa ole", async () => {
    const seen: { uploadMs: number; activeMs: number; transcribeMs: number; deleteMs: number }[] = [];
    const f = fake({ uploadUrl: "https://evil.example/upload" });
    await make(f, { onTimings: (t) => void seen.push(t) }).transcribeBytes(file(), "audio/ogg", "x", opts).catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0].uploadMs).toBeGreaterThanOrEqual(0);
    expect([seen[0].activeMs, seen[0].transcribeMs]).toEqual([0, 0]);
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("uusi ketju nollaa edellisen uusinnat", async () => {
    let n = 0;
    const f = fake({ interactions: () => (++n === 1 ? new Response("{}", { status: 503, headers: { "retry-after": "3" } }) : Response.json(INTERACTION)) });
    const client = make(f);
    expect((await client.transcribeBytes(file(), "audio/ogg", "x", opts)).timings!.retries).toBe(1);
    expect((await client.transcribeBytes(file(), "audio/ogg", "x", opts)).timings!.retries).toBe(0);
  });
});
