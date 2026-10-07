import type { Transcript } from "../clinical/schemas";

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
  transcribe(audio: Blob, opts: { language: string; signal?: AbortSignal }): Promise<Transcript>;
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

export function createTranscriptionAdapter(cfg: { provider: string }): TranscriptionAdapter {
  if (cfg.provider === "none" || !cfg.provider) {
    return new UnconfiguredTranscriptionAdapter(
      "Ei litterointipalvelua",
      "Litterointipalvelua ei ole asetettu (TRANSCRIPTION_PROVIDER). Kuuntele äänite ja liitä litteraatti käsin.",
    );
  }
  // Palvelukohtainen adapteri lisätään vasta todellisen palvelun dokumentaation ja testauksen perusteella.
  return new UnconfiguredTranscriptionAdapter(
    cfg.provider,
    `Litterointipalvelua "${cfg.provider}" ei ole toteutettu tässä versiossa. Liitä litteraatti käsin.`,
  );
}
