import { describe, expect, it } from "vitest";
import { GeminiError } from "../scripts/asr/gemini";
import { GeminiSpeaker, parseSpeechResponse } from "../scripts/asr/tts";
import { buildWav, parseWav } from "../scripts/asr/wav";

const KEY = "SECRET-KEY-123";
const HOST = "https://generativelanguage.googleapis.com";
const pcm = Uint8Array.from({ length: 4800 }, (_, i) => (i % 2 ? 0x10 : 0x00));
const wav = buildWav(pcm, 24000);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function speaker(reply: () => Response) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body) });
    return reply();
  }) as typeof fetch;
  return { calls, s: new GeminiSpeaker({ apiKey: KEY, model: "gemini-3.8-flash-tts", fetchImpl, sleep: async () => undefined }) };
}

describe("Gemini-puhesynteesi (kuvitellulla verkolla)", () => {
  it("pyyntö: malli, käyttäjän teksti, ääniasetus ja äänivastauksen vaatimus; avain otsakkeessa; ei tyylimerkintää ilman tyyliä", async () => {
    const { calls, s } = speaker(() => Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: b64(wav) }] }] }));
    const out = await s.speak("Mikä tuo tänään vastaanotolle?", "Charon");
    expect(calls[0].url).toBe(`${HOST}/v1beta/interactions`);
    expect(calls[0].headers["x-goog-api-key"]).toBe(KEY);
    expect(JSON.parse(calls[0].body)).toEqual({
      model: "gemini-3.8-flash-tts",
      input: [{ type: "user_input", content: [{ type: "text", text: "Mikä tuo tänään vastaanotolle?" }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Charon" }] },
    });
    expect(parseWav(out).pcm.length).toBe(pcm.length);
  });

  it("tyyliohje lähtee speech_metadata-merkintänä", async () => {
    const { calls, s } = speaker(() => Response.json({ steps: [{ content: [{ type: "audio", data: b64(wav) }] }] }));
    await s.speak("Hei", "Kore", "speaking slowly");
    const content = JSON.parse(calls[0].body).input[0].content[0];
    expect(content.annotations).toEqual([{ type: "speech_metadata", style: "speaking slowly" }]);
  });

  it("vastauksen jäsennys: viimeinen äänilohko voittaa; raaka PCM paketoidaan 24 kHz:n WAViksi; ääntä ei löydy -> virhe", () => {
    const early = buildWav(Uint8Array.from({ length: 2 }, () => 1), 24000);
    const r = parseSpeechResponse({ steps: [{ content: [{ type: "audio", data: b64(early) }] }, { content: [{ type: "text", text: "ei ääntä" }, { type: "audio", data: b64(wav) }] }] });
    expect(parseWav(r).pcm.length).toBe(pcm.length);

    const raw = parseSpeechResponse({ steps: [{ content: [{ mime_type: "audio/l16;rate=24000", data: b64(pcm) }] }] });
    expect(parseWav(raw)).toMatchObject({ sampleRate: 24000 });
    expect(parseWav(raw).pcm.length).toBe(pcm.length);

    expect(() => parseSpeechResponse({ steps: [{ content: [{ type: "text", text: "vain tekstiä" }] }] })).toThrow(GeminiError);
    expect(() => parseSpeechResponse(null)).toThrow(/ei löytynyt ääntä/);
  });

  it("virheviesti ei sisällä avainta (yhteinen HTTP-pohja)", async () => {
    const { s } = speaker(() => Response.json({ error: { message: `bad ${KEY}` } }, { status: 400 }));
    const err = await s.speak("Hei", "Kore").catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.message).not.toContain(KEY);
  });
});
