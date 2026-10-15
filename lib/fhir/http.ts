import type { OperationOutcome, OperationOutcomeIssue, Resource } from "./types";

export const FHIR_JSON = "application/fhir+json";

export type FhirErrorKind =
  | "network" // yhteys epäonnistui
  | "timeout" // aikakatkaisu; lopputulos voi olla tuntematon
  | "http" // palvelin palautti virhekoodin
  | "too-large" // vastauskoon raja ylittyi
  | "invalid-json"
  | "forbidden-url"; // osoite ei kuulu sallitulle palvelimelle/polulle

export interface FhirError {
  kind: FhirErrorKind;
  status?: number;
  message: string;
  issues?: OperationOutcomeIssue[];
}

export type FhirResponse<T = Resource> =
  | { ok: true; status: number; body: T; location?: string }
  | { ok: false; error: FhirError };

export interface FhirHttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxBytes?: number;
  readRetries?: number;
  fetchImpl?: typeof fetch;
  /** Odotus uusintojen välillä (ms); testeissä 0. */
  retryDelayMs?: number;
  /** OAuth-pääsytunniste; lähetetään Bearer-otsakkeena vain sallitulle palvelimelle. */
  accessToken?: string;
}

const MAX_REDIRECTS = 3;

/**
 * Tarkistaa, että osoite on sallitulla palvelimella ja FHIR-juuren alla.
 * Hylkää muut originit, protokollat ja polun ulkopuolelle osoittavat osoitteet.
 */
export function isAllowedUrl(url: string, baseUrl: string): boolean {
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(baseUrl);
  } catch {
    return false;
  }
  if (u.origin !== b.origin) return false;
  if (u.username || u.password) return false;
  const basePath = b.pathname.replace(/\/+$/, "");
  return u.pathname === basePath || u.pathname.startsWith(basePath + "/");
}

export function operationOutcomeIssues(body: unknown): OperationOutcomeIssue[] | undefined {
  if (body && typeof body === "object" && (body as Resource).resourceType === "OperationOutcome") {
    return (body as OperationOutcome).issue ?? [];
  }
  return undefined;
}

export function describeIssues(issues: OperationOutcomeIssue[] | undefined): string {
  if (!issues?.length) return "";
  return issues
    .map((i) => `${i.severity}: ${i.diagnostics ?? i.details?.text ?? i.code}`)
    .join("; ");
}

async function readLimited(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared && declared > maxBytes) return null;
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export class FhirHttp {
  readonly baseUrl: string;
  private timeoutMs: number;
  private maxBytes: number;
  private readRetries: number;
  private fetchImpl: typeof fetch;
  private retryDelayMs: number;
  private accessToken?: string;

  constructor(opts: FhirHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
    this.readRetries = opts.readRetries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    this.accessToken = opts.accessToken;
  }

  /** Muodostaa absoluuttisen osoitteen suhteellisesta polusta. */
  url(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (!path) return this.baseUrl;
    return `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
  }

  async get<T = Resource>(path: string, signal?: AbortSignal): Promise<FhirResponse<T>> {
    let last: FhirResponse<T> | undefined;
    for (let attempt = 0; attempt <= this.readRetries; attempt++) {
      if (attempt > 0 && this.retryDelayMs) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      }
      last = await this.request<T>("GET", path, undefined, signal);
      if (last.ok) return last;
      const retryable =
        last.error.kind === "network" ||
        last.error.kind === "timeout" ||
        (last.error.kind === "http" && (last.error.status === 429 || (last.error.status ?? 0) >= 500));
      if (!retryable || signal?.aborted) return last;
    }
    return last!;
  }

  /** POST ei uusita automaattisesti: lopputulos voi olla palvelimella jo voimassa. */
  async post<T = Resource>(path: string, body: unknown, signal?: AbortSignal): Promise<FhirResponse<T>> {
    return this.request<T>("POST", path, body, signal);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    outerSignal?: AbortSignal,
  ): Promise<FhirResponse<T>> {
    let url = this.url(path);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedUrl(url, this.baseUrl)) {
        return { ok: false, error: { kind: "forbidden-url", message: "Osoite ei kuulu sallitulle FHIR-palvelimelle." } };
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("timeout")), this.timeoutMs);
      const onAbort = () => ctrl.abort(outerSignal?.reason);
      outerSignal?.addEventListener("abort", onAbort);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Accept: FHIR_JSON,
            ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
            ...(body !== undefined ? { "Content-Type": `${FHIR_JSON}; charset=utf-8` } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: "manual",
          signal: ctrl.signal,
          cache: "no-store",
        });
      } catch (e) {
        clearTimeout(timer);
        outerSignal?.removeEventListener("abort", onAbort);
        if (outerSignal?.aborted) return { ok: false, error: { kind: "network", message: "Pyyntö peruttiin." } };
        if (ctrl.signal.aborted) {
          return { ok: false, error: { kind: "timeout", message: `Aikakatkaisu (${this.timeoutMs} ms).` } };
        }
        return { ok: false, error: { kind: "network", message: `Yhteys epäonnistui: ${(e as Error).message}` } };
      }

      try {
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          if (method !== "GET") {
            return { ok: false, error: { kind: "http", status: res.status, message: "Odottamaton uudelleenohjaus kirjoituksessa." } };
          }
          url = new URL(res.headers.get("location")!, url).toString();
          continue;
        }
        const text = await readLimited(res, this.maxBytes);
        if (text === null) {
          return { ok: false, error: { kind: "too-large", status: res.status, message: "Vastaus ylitti sallitun koon." } };
        }
        let parsed: unknown = undefined;
        if (text.trim()) {
          try {
            parsed = JSON.parse(text);
          } catch {
            if (res.ok) return { ok: false, error: { kind: "invalid-json", status: res.status, message: "Vastaus ei ollut JSONia." } };
          }
        }
        if (!res.ok) {
          const issues = operationOutcomeIssues(parsed);
          return {
            ok: false,
            error: {
              kind: "http",
              status: res.status,
              message: `HTTP ${res.status}${issues ? `: ${describeIssues(issues)}` : ""}`,
              issues,
            },
          };
        }
        return { ok: true, status: res.status, body: parsed as T, location: res.headers.get("location") ?? undefined };
      } catch (e) {
        if (ctrl.signal.aborted) {
          return { ok: false, error: { kind: "timeout", message: `Aikakatkaisu (${this.timeoutMs} ms).` } };
        }
        return { ok: false, error: { kind: "network", message: `Yhteys katkesi: ${(e as Error).message}` } };
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener("abort", onAbort);
      }
    }
    return { ok: false, error: { kind: "http", message: "Liian monta uudelleenohjausta." } };
  }
}
