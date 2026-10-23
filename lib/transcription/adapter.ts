import type { Transcript } from "../clinical/schemas";
import { GeminiTranscriptionAdapter } from "./gemini-adapter";
import type { StageTimings } from "./gemini-client";

export interface TranscriptionCapabilities {
  /** Koko tallenteen litterointi tallennuksen jälkeen. */
  batch: boolean;
  /** Osittaiset reaaliaikaiset tulokset puhevirrasta (myöhempi vaihe). */
  streamingPartials: boolean;
  /** Puhujien erottelu. Merkitään todeksi vasta, kun palvelu tukee sitä ja se on testattu. */
  diarization: boolean;
  /** Sanakohtaiset aikaleimat. */
  timestamps: boolean;
}

export interface TranscriptionAdapter {
  readonly name: string;
  readonly configured: boolean;
  readonly description: string;
  readonly capabilities: TranscriptionCapabilities;
  /** `onTimings` saa vaiheiden kestot ketjun lopussa (myös virheen jälkeen), jos palvelu mittaa niitä. */
  transcribe(audio: Blob, opts: { language: string; signal?: AbortSignal; onTimings?: (t: StageTimings) => void }): Promise<Transcript>;
  /** Myöhempi laajennus: puhevirta ja osittaiset tulokset. */
  openStream?(opts: { language: string; onPartial: (text: string) => void }): Promise<{ push(chunk: Blob): void; close(): Promise<Transcript> }>;
}

export class TranscriptionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionUnavailable";
  }
}

export class UnconfiguredTranscriptionAdapter implements TranscriptionAdapter {
  readonly configured = false;
  readonly capabilities: TranscriptionCapabilities = { batch: false, streamingPartials: false, diarization: false, timestamps: false };
  constructor(
    readonly name: string,
    readonly description: string,
  ) {}
  async transcribe(): Promise<Transcript> {
    throw new TranscriptionUnavailable(this.description);
  }
}

export interface TranscriptionSettings {
  provider: string;
  /** Vain palvelinpuolella: avainta ei koskaan lähetetä selaimelle. */
  geminiApiKey?: string;
  model?: string;
  thinkingLevel?: string;
}

/** Sallitut `TRANSCRIPTION_THINKING`-arvot; "default" jättää asetuksen pois (palvelun oletus). Oletus: low (nopeampi, ks. README). */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export function parseThinkingLevel(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "low";
  if (v === "default") return undefined;
  return (THINKING_LEVELS as readonly string[]).includes(v) ? v : "low";
}

export const DEFAULT_TRANSCRIPTION_MODEL = "gemini-3.8-flash";

export function createTranscriptionAdapter(cfg: TranscriptionSettings): TranscriptionAdapter {
  if (cfg.provider === "none" || !cfg.provider) {
    return new UnconfiguredTranscriptionAdapter(
      "Ei litterointipalvelua",
      "Litterointipalvelua ei ole asetettu (TRANSCRIPTION_PROVIDER). Kuuntele äänite ja liitä litteraatti käsin.",
    );
  }
  if (cfg.provider === "gemini") {
    if (!cfg.geminiApiKey) {
      return new UnconfiguredTranscriptionAdapter("Gemini (avain puuttuu)", "TRANSCRIPTION_PROVIDER=gemini, mutta GEMINI_API_KEY puuttuu palvelimen asetuksista. Liitä litteraatti käsin.");
    }
    return new GeminiTranscriptionAdapter({ apiKey: cfg.geminiApiKey, model: cfg.model || DEFAULT_TRANSCRIPTION_MODEL, thinkingLevel: cfg.thinkingLevel });
  }
  // Palvelukohtainen adapteri lisätään vasta todellisen palvelun dokumentaation ja testauksen perusteella.
  return new UnconfiguredTranscriptionAdapter(
    cfg.provider,
    `Litterointipalvelua "${cfg.provider}" ei ole toteutettu tässä versiossa. Liitä litteraatti käsin.`,
  );
}
