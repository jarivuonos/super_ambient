import { describe, expect, it } from "vitest";
import { parsePastedTranscript, transcriptToText } from "../lib/clinical/transcript";
import { createTranscriptionAdapter, parseThinkingLevel, TranscriptionUnavailable } from "../lib/transcription/adapter";
import { GeminiTranscriptionAdapter, languageCodeFor, MAX_SEGMENTS, normalizeMime, toTranscript } from "../lib/transcription/gemini-adapter";
import type { AsrResult } from "../lib/transcription/gemini-client";

const KEY = "SECRET-KEY-999";
const HOST = "https://generativelanguage.googleapis.com";
const UPLOAD = `${HOST}/upload/v1beta/files/x?upload_id=1`;

const words = (spec: [string, string | undefined][]): AsrResult => ({ text: spec.map((s) => s[0]).join(" "), words: spec.map(([text, speaker]) => ({ text, speaker })), raw: {} });

function fake(interactions: () => Response) {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    if (u === `${HOST}/upload/v1beta/files`) return new Response("{}", { headers: { "x-goog-upload-url": UPLOAD } });
    if (u === UPLOAD) return Response.json({ file: { uri: `${HOST}/v1beta/files/x`, name: "files/x" } });
    if (u === `${HOST}/v1beta/files/x`) return init?.method === "DELETE" ? Response.json({}) : Response.json({ state: "ACTIVE" });
    if (u === `${HOST}/v1beta/interactions`) return interactions();
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const REPLY = { output_text: "Speaker 1: Mikä tuo tänään?\nSpeaker 2: Vatsakipua.\nSpeaker 3: Hänen isällään on diabetes.\nSpeaker 1: Selvä." };
const adapter = (f: ReturnType<typeof fake>, over: { maxRetries?: number } = {}) => new GeminiTranscriptionAdapter({ apiKey: KEY, model: "gemini-3.8-flash", fetchImpl: f.fetchImpl, sleep: async () => undefined, ...over });
const ogg = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/ogg;codecs=opus" });

describe("äänimuodon ja kielen valinta", () => {
  it("MIME-tyypin parametrit pudotetaan ja yleiset muunnokset tunnistetaan; vieras muoto hylätään", () => {
    expect(normalizeMime("audio/ogg;codecs=opus")).toBe("audio/ogg");
    expect(normalizeMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeMime("AUDIO/X-WAV")).toBe("audio/wav");
    expect(normalizeMime("video/mp4")).toBeNull();
    expect(normalizeMime("")).toBeNull();
  });

  it("kielikoodit: fi, sv ja en laajennetaan, muu säilyy", () => {
    expect([languageCodeFor("fi"), languageCodeFor("sv"), languageCodeFor("en"), languageCodeFor("de-DE")]).toEqual(["fi-FI", "sv-SE", "en-US", "de-DE"]);
  });
});

describe("palvelun vastaus litteraatiksi", () => {
  it("peräkkäiset saman puhujan sanat yhdeksi puheenvuoroksi, puhujat 'Puhuja N', rooli tuntematon, lähde litterointipalvelu", () => {
    const t = toTranscript(words([["Hei", "spk_1"], ["miten", "spk_1"], ["voit?", "spk_1"], ["Hyvin.", "spk_2"], ["Hmm", "spk_1"]]));
    expect(t.segments.map((s) => [s.id, s.speaker, s.speakerLabel, s.text])).toEqual([
      ["s1", "tuntematon", "Puhuja 1", "Hei miten voit?"],
      ["s2", "tuntematon", "Puhuja 2", "Hyvin."],
      ["s3", "tuntematon", "Puhuja 1", "Hmm"],
    ]);
    expect(t.origin).toBe("litteroitu");
    expect(t.speakerSource).toBe("litterointipalvelu");
    expect(t.segments.every((s) => s.startMs === null && s.endMs === null)).toBe(true);
    expect(toTranscript(words([["Hei", "spk_1"], ["miten", "spk_1"], ["voit?", "spk_1"], ["Hyvin.", "spk_2"], ["Hmm", "spk_1"]])).version).toBe(t.version);
  });

  it("kirjaintunnukset numeroidaan ilmestymisjärjestyksessä", () => {
    const t = toTranscript(words([["a", "spk_b"], ["b", "spk_a"], ["c", "spk_b"]]));
    expect(t.segments.map((s) => s.speakerLabel)).toEqual(["Puhuja 1", "Puhuja 2", "Puhuja 1"]);
  });

  it("ilman puhujatietoa: rivit puheenvuoroiksi, lähde 'ei tiedossa', teksti ilman etuliitteitä", () => {
    const t = toTranscript({ text: "Ensimmäinen rivi.\n\nToinen rivi.", words: [], raw: {} });
    expect(t.speakerSource).toBe("ei tiedossa");
    expect(t.segments.map((s) => s.text)).toEqual(["Ensimmäinen rivi.", "Toinen rivi."]);
    expect(transcriptToText(t)).toBe("Ensimmäinen rivi.\nToinen rivi.");
  });

  it("tyhjä vastaus ja liian monta puheenvuoroa antavat selkeän virheen; pitkä puheenvuoro pilkotaan 5000 merkin paloihin", () => {
    expect(() => toTranscript({ text: "  ", words: [], raw: {} })).toThrow(TranscriptionUnavailable);
    const many = words(Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => ["x", `spk_${i % 2 === 0 ? 1 : 2}`] as [string, string]));
    expect(() => toTranscript(many)).toThrow(/liian pitkä/);
    const longText = Array.from({ length: 800 }, () => "Tämä on yksi lause.").join(" ");
    const t = toTranscript({ text: longText, words: [], raw: {} });
    expect(t.segments.length).toBeGreaterThan(2);
    expect(t.segments.every((s) => s.text.length <= 5000)).toBe(true);
    expect(t.segments.map((s) => s.text).join(" ")).toBe(longText);
  });

  it("tekstikentän kierto: 'Puhuja N' säilyy, ja käyttäjän vaihtama rooli tunnistuu roolina", () => {
    const t = toTranscript(words([["Mikä", "spk_1"], ["tuo?", "spk_1"], ["Vatsakipua.", "spk_2"]]));
    const text = transcriptToText(t);
    expect(text).toBe("Puhuja 1: Mikä tuo?\nPuhuja 2: Vatsakipua.");
    const again = parsePastedTranscript(text, "litteroitu");
    expect(again.segments.map((s) => [s.speaker, s.speakerLabel])).toEqual([["tuntematon", "Puhuja 1"], ["tuntematon", "Puhuja 2"]]);
    expect(transcriptToText(again)).toBe(text);
    const edited = parsePastedTranscript(text.replace("Puhuja 1:", "Lääkäri:").replace("Puhuja 2:", "Potilas:"), "litteroitu");
    expect(edited.segments.map((s) => s.speaker)).toEqual(["ammattilainen", "potilas"]);
  });
});

describe("Gemini-adapteri (kuvitellulla verkolla)", () => {
  it("koko ketju: litteraatti puhujamerkinnöin; pyyntö pyytää suomea, puhujien erottelua ja numeroita numeroina; tiedosto poistetaan", async () => {
    const f = fake(() => Response.json(REPLY));
    const t = await adapter(f).transcribe(ogg(), { language: "fi" });
    expect(transcriptToText(t)).toBe("Puhuja 1: Mikä tuo tänään?\nPuhuja 2: Vatsakipua.\nPuhuja 3: Hänen isällään on diabetes.\nPuhuja 1: Selvä.");
    const body = JSON.parse(f.calls.find((c) => c.url.endsWith("/interactions"))!.body);
    expect(body.model).toBe("gemini-3.8-flash");
    expect(body.input[0].text).toContain("Finnish");
    expect(body.input[0].text).toContain("as digits");
    expect(body.input[0].text).toContain("Speaker 1:");
    expect(body.input[1]).toMatchObject({ type: "audio", mime_type: "audio/ogg" });
    expect(JSON.parse(f.calls[0].body).file.display_name).toMatch(/^ambient-[0-9a-f]{8}$/);
    expect(f.calls[f.calls.length - 1].method).toBe("DELETE");
  });

  it("tukematon äänimuoto hylätään ennen kuin mitään lähetetään", async () => {
    const f = fake(() => Response.json(REPLY));
    await expect(adapter(f).transcribe(new Blob([new Uint8Array([1])], { type: "video/mp4" }), { language: "fi" })).rejects.toThrow(/ei tueta/);
    expect(f.calls).toHaveLength(0);
  });

  it("virheet: kiinteät suomenkieliset viestit ilman palvelun tekstiä tai avainta", async () => {
    const run = async (status: number, message: string) => {
      const f = fake(() => Response.json({ error: { message } }, { status }));
      return adapter(f, { maxRetries: 0 }).transcribe(ogg(), { language: "fi" }).catch((e) => e);
    };
    const busy = await run(503, `high demand ${KEY} salainen`);
    expect(busy).toBeInstanceOf(TranscriptionUnavailable);
    expect(busy.message).toContain("HTTP 503");
    expect(busy.message).not.toMatch(/salainen|high demand/);
    expect(busy.message).not.toContain(KEY);

    const quota = await run(429, "limit: 10 requests per day. retry in 23h");
    expect(quota.message).toContain("käyttökiintiö");
    expect(quota.message).not.toContain("23h");

    const auth = await run(403, `bad key ${KEY}`);
    expect(auth.message).toContain("GEMINI_API_KEY");
    expect(auth.message).not.toContain(KEY);
  });

  it("peruutus ennen aloitusta: ei verkkopyyntöjä, viesti 'Pyyntö peruttiin.'", async () => {
    const f = fake(() => Response.json(REPLY));
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await adapter(f).transcribe(ogg(), { language: "fi", signal: ctrl.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionUnavailable);
    expect(err.message).toBe("Pyyntö peruttiin.");
    expect(f.calls).toHaveLength(0);
  });
});

describe("litterointipalvelun valinta", () => {
  it("oletus ei lähetä mitään: ei palvelua; tuntematon palvelu kertoo ettei sitä ole toteutettu", () => {
    const none = createTranscriptionAdapter({ provider: "none" });
    expect(none.configured).toBe(false);
    expect(none.name).toBe("Ei litterointipalvelua");
    expect(createTranscriptionAdapter({ provider: "jokinmuu" }).description).toMatch(/ei ole toteutettu/);
  });

  it("gemini ilman avainta on ei-käytössä ja kertoo puuttuvan avaimen; avaimen kanssa käytössä", () => {
    const missing = createTranscriptionAdapter({ provider: "gemini" });
    expect(missing.configured).toBe(false);
    expect(missing.description).toContain("GEMINI_API_KEY");
    const ok = createTranscriptionAdapter({ provider: "gemini", geminiApiKey: KEY, model: "gemini-3.8-flash" });
    expect(ok.configured).toBe(true);
    expect(ok.name).toBe("Google Gemini");
    expect(ok.description).toContain("synteettistä puhetta");
    expect(ok.description).not.toContain(KEY);
  });
});

describe("vaiheiden kestot adapterin läpi", () => {
  it("onTimings saa mittauksen onnistuneen ketjun lopussa ja virheen jälkeen", async () => {
    const ok: { audioBytes: number }[] = [];
    await adapter(fake(() => Response.json(REPLY))).transcribe(ogg(), { language: "fi", onTimings: (t) => void ok.push(t) });
    expect(ok).toHaveLength(1);
    expect(ok[0].audioBytes).toBe(4);

    const failed: { retries: number }[] = [];
    const f = fake(() => Response.json({ error: { message: "x" } }, { status: 503 }));
    const err = await adapter(f, { maxRetries: 1 }).transcribe(ogg(), { language: "fi", onTimings: (t) => void failed.push(t) }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionUnavailable);
    expect(failed).toHaveLength(1);
    expect(failed[0].retries).toBe(1);
  });
});

describe("ajattelun määrä asetuksena", () => {
  it("TRANSCRIPTION_THINKING: tyhjä on low, default jättää pois, tuntematon on low, isot kirjaimet kelpaavat", () => {
    expect(parseThinkingLevel(undefined)).toBe("low");
    expect(parseThinkingLevel("")).toBe("low");
    expect(parseThinkingLevel("default")).toBeUndefined();
    expect(parseThinkingLevel(" HIGH ")).toBe("high");
    expect(parseThinkingLevel("minimal")).toBe("minimal");
    expect(parseThinkingLevel("hyper")).toBe("low");
  });

  it("adapteri välittää tason pyyntöön; ilman tasoa pyynnössä ei ole generation_configia", async () => {
    const f = fake(() => Response.json(REPLY));
    await new GeminiTranscriptionAdapter({ apiKey: KEY, model: "gemini-3.8-flash", thinkingLevel: "low", fetchImpl: f.fetchImpl, sleep: async () => undefined }).transcribe(ogg(), { language: "fi" });
    expect(JSON.parse(f.calls.find((c) => c.url.endsWith("/interactions"))!.body).generation_config).toEqual({ thinking_level: "low" });
    const g = fake(() => Response.json(REPLY));
    await adapter(g).transcribe(ogg(), { language: "fi" });
    expect(JSON.parse(g.calls.find((c) => c.url.endsWith("/interactions"))!.body).generation_config).toBeUndefined();
  });
});
