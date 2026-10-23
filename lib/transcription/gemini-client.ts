// Gemini-asiakas (Files API + Interactions API): litterointi ja puhesynteesi. Ei `server-only`-tuontia, jotta sitä voi käyttää
// myös koeajoskripteissä (scripts/asr) ja testeissä. Sovelluksen palvelin käyttää sitä vain, kun TRANSCRIPTION_PROVIDER=gemini
// (lib/transcription/gemini-adapter.ts); oletuksena mitään ei lähetetä. Ei uusia riippuvuuksia: pelkkä fetch.
// Avain annetaan ulkopuolelta eikä sitä koskaan tulosteta tai liitetä virheviesteihin.

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
  /** Pyydä numerot, mittaukset, annokset ja päivämäärät numeroina (vain kehotetilassa). */
  digits?: boolean;
}

/** "transcribe": erillinen litterointimalli (transcription_config). "prompt": yleismalli, jolle litterointi pyydetään tekstikehotteella. */
export type Engine = "transcribe" | "prompt";

export const engineFor = (model: string): Engine => (/transcribe/i.test(model) ? "transcribe" : "prompt");

const LANGUAGE_NAMES: Record<string, string> = { fi: "Finnish", sv: "Swedish", en: "English" };

/** Kehote yleismallille. Diarisointi pyydetään riveinä "Speaker N: teksti", jotka jäsennetään sanoiksi puhujineen. */
export function transcriptionPrompt(languageCodes: string[], diarize: boolean, digits = false): string {
  const lang = LANGUAGE_NAMES[(languageCodes[0] ?? "fi").slice(0, 2).toLowerCase()] ?? languageCodes[0];
  const base = `Transcribe the speech in this audio recording verbatim. The language is ${lang}. Do not summarize, translate, correct, or add anything, and write down exactly what was said, including negations such as "ei" or "inte". Output only the transcript, with no introduction or comments.`;
  const withDigits = digits
    ? `${base} Write all numbers, measurements, doses and dates as digits (for example "145/90", "5 mg", "38,5", "12.5.2019"), never spelled out as words.`
    : base;
  return diarize
    ? `${withDigits} Identify the distinct speakers and put each speaker turn on its own line, starting with the label "Speaker 1:", "Speaker 2:" and so on (use the same number for the same voice throughout).`
    : withDigits;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** Oletus johdetaan mallin nimestä (nimi sisältää "transcribe" -> erillinen litterointimalli). */
  engine?: Engine;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Käyttäjän peruutus (esim. selaimen pyyntö katkesi): pysäyttää pyynnöt eikä uusi niitä. Tiedoston poisto ei noudata tätä. */
  signal?: AbortSignal;
  /** Kutsutaan ennen jokaista uusintaa (esim. tulostukseen), jotta pitkä odotus ei ole hiljainen. */
  onRetry?: (info: { status?: number; waitMs: number; attempt: number; maxRetries: number }) => void;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Yhteinen HTTP-pohja: avain, uusinnat (429/5xx) ja virheviestit ilman avainta. Litterointi ja puhesynteesi perivät tämän. */
export class GeminiHttp {
  protected base: string;
  protected f: typeof fetch;
  protected sleep: (ms: number) => Promise<void>;
  protected retries: number;

  constructor(protected o: GeminiOptions) {
    this.base = (o.baseUrl ?? GEMINI_BASE).replace(/\/+$/, "");
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retries = o.maxRetries ?? 3;
  }

  /** Virheviesti ilman avainta ja lyhennettynä. */
  protected safe(text: string): string {
    return text.split(this.o.apiKey).join("***").replace(/\s+/g, " ").slice(0, 300);
  }

  /** Kertoo, onko 429 päiväkohtainen kiintiö (viestissä "per day" tai "daily") eikä minuuttikohtainen. */
  protected async isDailyQuota(res: Response): Promise<boolean> {
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      return /per day|daily/i.test(body?.error?.message ?? "");
    } catch {
      return false;
    }
  }

  protected async errorFrom(res: Response): Promise<GeminiError> {
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
  protected async request(url: string, init: RequestInit, timeoutMs: number, honorCancel = true): Promise<Response> {
    const outer = honorCancel ? this.o.signal : undefined;
    for (let attempt = 0; ; attempt++) {
      if (outer?.aborted) throw new GeminiError("Pyyntö peruttiin.");
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        res = await this.f(url, { ...init, redirect: "manual", cache: "no-store", signal: outer ? AbortSignal.any([timeout, outer]) : timeout });
      } catch (e) {
        if (outer?.aborted) throw new GeminiError("Pyyntö peruttiin.");
        if (attempt >= this.retries) throw new GeminiError(`Yhteys epäonnistui: ${this.safe((e as Error).message)}`);
        const wait = 2000 * 2 ** attempt;
        this.o.onRetry?.({ waitMs: wait, attempt: attempt + 1, maxRetries: this.retries });
        await this.sleep(wait);
        continue;
      }
      if (res.ok) return res;
      if (!RETRYABLE.has(res.status) || attempt >= this.retries) throw await this.errorFrom(res);
      // Päiväkiintiö täynnä: odotus ei auta (palautuu vasta vuorokauden päästä), joten ei uusintoja.
      if (res.status === 429 && (await this.isDailyQuota(res.clone()))) throw await this.errorFrom(res);
      const ra = Number(res.headers.get("retry-after"));
      const wait = Math.min(60_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt);
      this.o.onRetry?.({ status: res.status, waitMs: wait, attempt: attempt + 1, maxRetries: this.retries });
      await this.sleep(wait);
    }
  }

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "x-goog-api-key": this.o.apiKey, ...extra };
  }

}

export class GeminiTranscriber extends GeminiHttp {
  readonly engine: Engine;

  constructor(o: GeminiOptions) {
    super(o);
    this.engine = o.engine ?? engineFor(o.model);
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
    // Poisto tehdään myös peruutuksen jälkeen, jotta ääni ei jää Googlelle 48 tunniksi.
    await this.request(`${this.base}/v1beta/${name}`, { method: "DELETE", headers: this.headers() }, 30_000, false);
  }

  async transcribe(file: { uri: string; mimeType: string }, opt: TranscribeOptions): Promise<AsrResult> {
    if (this.engine === "prompt") return this.transcribeByPrompt(file, opt);
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

  /** Yleismalli: litterointi pyydetään kehotteella (ei transcription_config-asetuksia, ei sanakohtaisia aikaleimoja). */
  private async transcribeByPrompt(file: { uri: string; mimeType: string }, opt: TranscribeOptions): Promise<AsrResult> {
    const res = await this.request(
      `${this.base}/v1beta/interactions`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          model: this.o.model,
          input: [
            { type: "text", text: transcriptionPrompt(opt.languageCodes, opt.diarize, opt.digits) },
            { type: "audio", uri: file.uri, mime_type: file.mimeType },
          ],
        }),
      },
      600_000,
    );
    const parsed = parseInteraction(await res.json().catch(() => null));
    const words = opt.diarize ? parseSpeakerLines(parsed.text) : [];
    return { ...parsed, words };
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
  if (!texts.length) collectTexts(body.outputs, texts, 0);
  const text = typeof body.output_text === "string" ? body.output_text : texts.join("");
  if (!text.trim() && words.length === 0) throw new GeminiError("Litterointivastauksesta ei löytynyt tekstiä (vastauksen muoto voi poiketa dokumentaatiosta; katso tallennettu raakavastaus).");
  return { text, words, raw: body };
}

/** Varalla: yleismallin vastaus voi olla `outputs`-listassa; kerätään sieltä `text`-kentät (vastaus tallennetaan raakana). */
function collectTexts(node: unknown, out: string[], depth: number): void {
  if (depth > 4) return;
  if (Array.isArray(node)) {
    for (const n of node) collectTexts(n, out, depth + 1);
  } else if (isObj(node)) {
    if (typeof node.text === "string") out.push(node.text);
    for (const k of ["content", "parts", "outputs"]) collectTexts(node[k], out, depth + 1);
  }
}

const SPEAKER_LINE = /^\s*(?:\*\*)?\s*(?:speaker|puhuja)\s*([A-Za-z0-9]+)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$/iu;

/** Rivit "Speaker 1: teksti" sanoiksi puhujatunnuksineen (spk_1, …). Ilman tunnistettuja rivejä palautuu tyhjä lista. */
export function parseSpeakerLines(text: string): AsrWord[] {
  const words: AsrWord[] = [];
  let found = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = SPEAKER_LINE.exec(line);
    if (!m) continue;
    found = true;
    for (const w of m[2].split(/\s+/).filter(Boolean)) words.push({ text: w, speaker: `spk_${m[1].toLowerCase()}` });
  }
  return found ? words : [];
}
