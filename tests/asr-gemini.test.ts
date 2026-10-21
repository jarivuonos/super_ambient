import { describe, expect, it } from "vitest";
import { GeminiError, GeminiTranscriber, parseInteraction } from "../scripts/asr/gemini";

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
