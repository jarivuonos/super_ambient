import type { Transcript, TranscriptSegment } from "../clinical/schemas";
import { transcriptVersion } from "../clinical/transcript";
import { TranscriptionUnavailable, type TranscriptionAdapter, type TranscriptionCapabilities } from "./adapter";
import { GeminiError, GeminiTranscriber, type AsrResult } from "./gemini-client";

// Gemini-litterointi (valinnainen, TRANSCRIPTION_PROVIDER=gemini). Ääni lähetetään Googlelle (Files API) ja poistetaan sieltä
// litteroinnin jälkeen. Puhujat merkitään "Puhuja N"; rooleiksi (lääkäri, potilas, läheinen) käyttäjä muuttaa ne käsin.
// Virheviestit ovat kiinteitä: ne eivät sisällä avainta, äänen sisältöä eikä palvelun omaa tekstiä.

export const MAX_SEGMENTS = 500;
const MAX_SEGMENT_CHARS = 5000;

const MIME_ALIASES: Record<string, string> = { "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/mp4": "audio/m4a", "audio/x-m4a": "audio/m4a", "audio/x-flac": "audio/flac", "audio/x-aiff": "audio/aiff" };
const SUPPORTED = new Set(["audio/wav", "audio/mp3", "audio/mpeg", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac", "audio/m4a", "audio/opus", "audio/webm"]);

/** "audio/ogg;codecs=opus" -> "audio/ogg"; null, jos Gemini ei tue muotoa. */
export function normalizeMime(type: string): string | null {
  const base = type.split(";")[0].trim().toLowerCase();
  const mime = MIME_ALIASES[base] ?? base;
  return SUPPORTED.has(mime) ? mime : null;
}

const LANGUAGE_CODES: Record<string, string> = { fi: "fi-FI", sv: "sv-SE", en: "en-US" };
export function languageCodeFor(language: string): string {
  return LANGUAGE_CODES[language.slice(0, 2).toLowerCase()] ?? language;
}

/** Pitkä teksti paloiksi lauseiden rajoilla (puheenvuoron enimmäispituus on 5000 merkkiä). */
function chunk(text: string): string[] {
  if (text.length <= MAX_SEGMENT_CHARS) return [text];
  const out: string[] = [];
  let cur = "";
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + 1 + sentence.length > MAX_SEGMENT_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${sentence}` : sentence;
    while (cur.length > MAX_SEGMENT_CHARS) {
      out.push(cur.slice(0, MAX_SEGMENT_CHARS));
      cur = cur.slice(MAX_SEGMENT_CHARS);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Puhujatunnus (esim. "spk_2" tai "spk_a") -> "Puhuja N": numerolliset säilytetään, muut numeroidaan ilmestymisjärjestyksessä. */
function labeller() {
  const seen = new Map<string, string>();
  return (id: string) => {
    let label = seen.get(id);
    if (!label) {
      const n = /(\d+)\s*$/.exec(id)?.[1];
      label = `Puhuja ${n ?? seen.size + 1}`;
      seen.set(id, label);
    }
    return label;
  };
}

/** Palvelun vastaus litteraatiksi. Rooli on aina "tuntematon" (palvelu ei tiedä, kuka on lääkäri); puhuja näkyy tunnisteessa. */
export function toTranscript(result: AsrResult): Transcript {
  const segments: Omit<TranscriptSegment, "id">[] = [];
  const hasSpeakers = result.words.some((w) => w.speaker !== undefined);
  if (hasSpeakers) {
    const label = labeller();
    let cur: { speaker: string | undefined; words: string[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const text = cur.words.join(" ").trim();
      if (text) for (const part of chunk(text)) segments.push({ speaker: "tuntematon", ...(cur.speaker !== undefined ? { speakerLabel: label(cur.speaker) } : {}), text: part, startMs: null, endMs: null });
    };
    for (const w of result.words) {
      if (!cur || cur.speaker !== w.speaker) {
        flush();
        cur = { speaker: w.speaker, words: [] };
      }
      cur.words.push(w.text);
    }
    flush();
  } else {
    for (const line of result.text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean)) {
      for (const part of chunk(line)) segments.push({ speaker: "tuntematon", text: part, startMs: null, endMs: null });
    }
  }
  if (!segments.length) throw new TranscriptionUnavailable("Litterointipalvelu ei palauttanut tekstiä. Äänite voi olla hiljainen; tarkista mikrofonin taso.");
  if (segments.length > MAX_SEGMENTS) throw new TranscriptionUnavailable(`Litteraatti on liian pitkä (yli ${MAX_SEGMENTS} puheenvuoroa). Äänitä lyhyempi pätkä.`);
  const withIds: TranscriptSegment[] = segments.map((s, i) => ({ id: `s${i + 1}`, ...s }));
  return { version: transcriptVersion(withIds), origin: "litteroitu", speakerSource: hasSpeakers ? "litterointipalvelu" : "ei tiedossa", segments: withIds };
}

/** Kiinteä, käyttäjälle näytettävä viesti: ei palvelun tekstiä eikä avainta. */
export function friendlyError(e: GeminiError): string {
  if (e.status === 429) return "Palvelun käyttökiintiö on täynnä (HTTP 429). Yritä myöhemmin; ilmaisella tasolla päiväkiintiö on pieni.";
  if (e.status === 503 || e.status === 502 || e.status === 504 || e.status === 500) return `Litterointipalvelu on ruuhkautunut tai ei vastaa (HTTP ${e.status}). Yritä hetken päästä uudelleen.`;
  if (e.status === 401 || e.status === 403) return `Litterointipalvelu ei hyväksynyt avainta tai oikeuksia (HTTP ${e.status}). Tarkista GEMINI_API_KEY.`;
  if (e.status !== undefined) return `Litterointipalvelu hylkäsi pyynnön (HTTP ${e.status}).`;
  if (/peruttiin/i.test(e.message)) return "Pyyntö peruttiin.";
  return "Yhteys litterointipalveluun epäonnistui.";
}

export interface GeminiAdapterOptions {
  apiKey: string;
  model: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiTranscriptionAdapter implements TranscriptionAdapter {
  readonly name = "Google Gemini";
  readonly configured = true;
  readonly description =
    "Gemini litteroi äänitteen (kokeellinen). Ääni lähetetään Googlelle: käytä vain synteettistä puhetta, koska ilmaisen tason syötteitä voidaan käyttää Googlen tuotteiden parantamiseen. Puhujat merkitään Puhuja 1, 2…; muuta ne rooleiksi (Lääkäri, Potilas, Läheinen) tekstikentässä. Erottelu on kokeellinen: lyhyet kolmannen puhujan vuorot voivat yhdistyä toiseen. Litterointi voi kestää minuutteja.";
  readonly capabilities: TranscriptionCapabilities = { batch: true, streamingPartials: false, diarization: true, timestamps: false };

  constructor(private o: GeminiAdapterOptions) {}

  async transcribe(audio: Blob, opts: { language: string; signal?: AbortSignal }): Promise<Transcript> {
    const mime = normalizeMime(audio.type);
    if (!mime) throw new TranscriptionUnavailable(`Äänitteen muotoa${audio.type ? ` (${audio.type.split(";")[0]})` : ""} ei tueta.`);
    const client = new GeminiTranscriber({ apiKey: this.o.apiKey, model: this.o.model, maxRetries: this.o.maxRetries ?? 3, signal: opts.signal, fetchImpl: this.o.fetchImpl, sleep: this.o.sleep });
    try {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const result = await client.transcribeBytes(bytes, mime, `ambient-${crypto.randomUUID().slice(0, 8)}`, { languageCodes: [languageCodeFor(opts.language)], diarize: true, timestamps: false, digits: true });
      return toTranscript(result);
    } catch (e) {
      if (e instanceof GeminiError) throw new TranscriptionUnavailable(friendlyError(e));
      throw e;
    }
  }
}
