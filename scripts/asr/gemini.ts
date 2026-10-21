// Gemini-litteroinnin asiakas koeajoskriptille (Files API + Interactions API). EI kuulu sovellukseen:
// sovelluksen palvelin ei tuo tätä, eikä ääntä lähetetä mihinkään ilman `--send`-valitsinta.
// Ei uusia riippuvuuksia: pelkkä fetch. Avain annetaan ulkopuolelta eikä sitä koskaan tulosteta.

export const GEMINI_BASE = "https://generativelanguage.googleapis.com";

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export interface AsrWord {
  text: string;
  speaker?: string;
  /** Palvelun antamat aikaleimat sellaisenaan (muoto varmistuu ensimmäisessä ajossa). */
  startRaw?: unknown;
  endRaw?: unknown;
}

export interface AsrResult {
  text: string;
  words: AsrWord[];
  /** Vastaus sellaisenaan: tallennetaan ajon tuloksiin, koska vastauksen muoto on uusi ja voi poiketa dokumentaatiosta. */
  raw: unknown;
}

export interface TranscribeOptions {
  languageCodes: string[];
  /** Puhujien erottelu (verbatim-tila). */
  diarize: boolean;
  /** Sanakohtaiset aikaleimat; voivat heikentää tarkkuutta. */
  timestamps: boolean;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export class GeminiTranscriber {
  private base: string;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private retries: number;

  constructor(private o: GeminiOptions) {
    this.base = (o.baseUrl ?? GEMINI_BASE).replace(/\/+$/, "");
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retries = o.maxRetries ?? 3;
  }

  /** Virheviesti ilman avainta ja lyhennettynä. */
  private safe(text: string): string {
    return text.split(this.o.apiKey).join("***").replace(/\s+/g, " ").slice(0, 300);
  }

  private async errorFrom(res: Response): Promise<GeminiError> {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? "";
    } catch {
      /* ei JSONia */
    }
    return new GeminiError(`HTTP ${res.status}${detail ? `: ${this.safe(detail)}` : ""}`, res.status);
  }

  /** Pyyntö uusinnoin: 429 ja 5xx odotetaan ja yritetään uudelleen (Retry-After huomioiden, enintään 60 s). */
  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.f(url, { ...init, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (attempt >= this.retries) throw new GeminiError(`Yhteys epäonnistui: ${this.safe((e as Error).message)}`);
        await this.sleep(2000 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      if (!RETRYABLE.has(res.status) || attempt >= this.retries) throw await this.errorFrom(res);
      const ra = Number(res.headers.get("retry-after"));
      await this.sleep(Math.min(60_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt));
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "x-goog-api-key": this.o.apiKey, ...extra };
  }

  /** Lataa tiedoston Files API:iin (resumable-protokolla). Palauttaa tiedoston osoitteen ja nimen. */
  async upload(bytes: Uint8Array, mimeType: string, displayName: string): Promise<{ uri: string; name: string }> {
    const start = await this.request(
      `${this.base}/upload/v1beta/files`,
      {
        method: "POST",
        headers: this.headers({
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ file: { display_name: displayName } }),
      },
      60_000,
    );
    const uploadUrl = start.headers.get("x-goog-upload-url");
    // Äänitiedoston tavut lähetetään vain Googlen omalle palvelimelle, vaikka vastaus osoittaisi muualle.
    if (!uploadUrl || new URL(uploadUrl).origin !== new URL(this.base).origin) {
      throw new GeminiError("Latausosoite puuttui tai ei ollut Googlen palvelimella; tiedostoa ei lähetetty.");
    }
    const done = await this.request(
      uploadUrl,
      {
        method: "POST",
        headers: { "Content-Length": String(bytes.byteLength), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
        body: bytes as unknown as BodyInit,
      },
      300_000,
    );
    const body = (await done.json().catch(() => null)) as { file?: { uri?: string; name?: string } } | null;
    if (!body?.file?.uri || !body.file.name) throw new GeminiError("Latausvastaus ei sisältänyt tiedoston osoitetta.");
    return { uri: body.file.uri, name: body.file.name };
  }

  /** Odottaa, että tiedosto on käsitelty (jos palvelu ilmoittaa tilan). */
  async waitActive(name: string, maxMs = 60_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const res = await this.request(`${this.base}/v1beta/${name}`, { method: "GET", headers: this.headers() }, 30_000);
      const body = (await res.json().catch(() => null)) as { state?: string } | null;
      if (!body?.state || body.state === "ACTIVE") return;
      if (body.state === "FAILED") throw new GeminiError("Tiedoston käsittely epäonnistui palvelussa.");
      if (Date.now() - t0 > maxMs) throw new GeminiError("Tiedosto ei ehtinyt tulla käyttövalmiiksi.");
      await this.sleep(2000);
    }
  }

  async delete(name: string): Promise<void> {
    await this.request(`${this.base}/v1beta/${name}`, { method: "DELETE", headers: this.headers() }, 30_000);
  }

  async transcribe(file: { uri: string; mimeType: string }, opt: TranscribeOptions): Promise<AsrResult> {
    const mode: Json = { type: "verbatim" };
    if (opt.diarize) mode.diarization_mode = "speaker";
    if (opt.timestamps) mode.timestamp_granularities = ["word"];
    const transcription_config: Json = { language_codes: opt.languageCodes };
    if (opt.diarize || opt.timestamps) transcription_config.mode = mode;
    const res = await this.request(
      `${this.base}/v1beta/interactions`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          model: this.o.model,
          input: [{ type: "audio", uri: file.uri, mime_type: file.mimeType }],
          generation_config: { transcription_config },
        }),
      },
      600_000,
    );
    return parseInteraction(await res.json().catch(() => null));
  }

  /** Koko ketju: lataa, odota, litteroi ja poista tiedosto palvelusta myös virhetilanteessa. */
  async transcribeBytes(bytes: Uint8Array, mimeType: string, displayName: string, opt: TranscribeOptions): Promise<AsrResult> {
    const up = await this.upload(bytes, mimeType, displayName);
    try {
      await this.waitActive(up.name);
      return await this.transcribe({ uri: up.uri, mimeType }, opt);
    } finally {
      await this.delete(up.name).catch(() => undefined);
    }
  }
}

/** Lukee vastauksen varovasti: teksti (`output_text` tai askelten tekstit) ja sanakohtaiset huomautukset. */
export function parseInteraction(body: unknown): AsrResult {
  if (!isObj(body)) throw new GeminiError("Litterointivastaus ei ollut JSON-olio.");
  const texts: string[] = [];
  const words: AsrWord[] = [];
  const steps = Array.isArray(body.steps) ? body.steps : [];
  for (const step of steps) {
    if (!isObj(step) || !Array.isArray(step.content)) continue;
    for (const c of step.content) {
      if (!isObj(c)) continue;
      if (typeof c.text === "string") texts.push(c.text);
      for (const a of Array.isArray(c.annotations) ? c.annotations : []) {
        if (isObj(a) && a.type === "word_info" && typeof a.text === "string") {
          words.push({ text: a.text, speaker: typeof a.speaker === "string" ? a.speaker : undefined, startRaw: a.start_offset, endRaw: a.end_offset });
        }
      }
    }
  }
  const text = typeof body.output_text === "string" ? body.output_text : texts.join("");
  if (!text.trim() && words.length === 0) throw new GeminiError("Litterointivastauksesta ei löytynyt tekstiä (vastauksen muoto voi poiketa dokumentaatiosta; katso tallennettu raakavastaus).");
  return { text, words, raw: body };
}
