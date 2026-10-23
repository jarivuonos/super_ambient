// Gemini-puhesynteesi koeajon testiaineiston tekemiseen (synteettiset dialogit). EI kuulu sovellukseen.
// Pyyntömuoto: Interactions API, response_format audio; vastaus on WAV (24 kHz, mono, 16 bit) base64:nä.

import { GeminiError, GeminiHttp } from "./gemini";
import { buildWav } from "./wav";

export const DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts";
const DEFAULT_RATE = 24000;

/** Etsii vastauksesta viimeisen äänilohkon (base64) ja palauttaa WAV-tavut. Raaka PCM (ilman RIFF-otsaketta) paketoidaan 24 kHz:n WAV:ksi. */
export function parseSpeechResponse(body: unknown): Uint8Array {
  const found: { data: string; mime?: string }[] = [];
  const visit = (n: unknown, depth: number) => {
    if (depth > 6) return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, depth + 1));
    if (typeof n !== "object" || n === null) return;
    const o = n as Record<string, unknown>;
    const mime = typeof o.mime_type === "string" ? o.mime_type : undefined;
    if (typeof o.data === "string" && (o.type === "audio" || mime?.startsWith("audio/"))) found.push({ data: o.data, mime });
    for (const k of ["steps", "content", "outputs", "parts"]) visit(o[k], depth + 1);
  };
  visit(body, 0);
  const last = found[found.length - 1];
  if (!last) throw new GeminiError("Puhesynteesin vastauksesta ei löytynyt ääntä (vastauksen muoto voi poiketa dokumentaatiosta).");
  const bytes = new Uint8Array(Buffer.from(last.data, "base64"));
  const isWav = bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
  return isWav ? bytes : buildWav(bytes, DEFAULT_RATE);
}

export class GeminiSpeaker extends GeminiHttp {
  /** Yksi puheenvuoro valitulla äänellä. `style` on valinnainen tyyliohje (esim. tahti tai sävy). */
  async speak(text: string, voice: string, style?: string): Promise<Uint8Array> {
    const res = await this.request(
      `${this.base}/v1beta/interactions`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          model: this.o.model,
          input: [{ type: "user_input", content: [{ type: "text", text, ...(style ? { annotations: [{ type: "speech_metadata", style }] } : {}) }] }],
          response_format: { type: "audio" },
          generation_config: { speech_config: [{ voice }] },
        }),
      },
      300_000,
    );
    return parseSpeechResponse(await res.json().catch(() => null));
  }
}
