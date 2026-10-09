// Ohut asiakas TypeSafe System One (Jev) -rajapinnalle.
// Jev ei kirjoita tekstiä: se palauttaa tyypitettyjä päätöksiä (choice / score / noul).
// Avain annetaan konstruktorissa palvelinpuolelta. Virheviestit eivät sisällä avainta,
// pyynnön sisältöä (kysymystekstiä) eikä vastauksen runkoa.

import { z } from "zod";

export type JevQuestionType = "choice" | "score" | "noul";

export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  criteria?: Record<string, string>;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const Prob = z.number().transform(clamp01);

const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), Prob).optional(),
  confidence: Prob.optional(),
});
const NoulAnswer = z.object({ type: z.literal("noul"), noul: Prob });
const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), Prob).optional(),
  confidence: Prob.optional(),
});

export const JevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.discriminatedUnion("type", [ChoiceAnswer, NoulAnswer, ScoreAnswer])),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
});
export type JevResponse = z.infer<typeof JevResponseSchema>;
export type JevAnswer = JevResponse["answers"][string];

export type JevErrorKind = "auth" | "validation" | "rate-limit" | "overloaded" | "server" | "timeout" | "network" | "bad-response" | "aborted";

const MESSAGES: Record<JevErrorKind, string> = {
  auth: "Jev hylkäsi avaimen (tarkista TYPESAFE_API_KEY).",
  validation: "Jev hylkäsi pyynnön rakenteen.",
  "rate-limit": "Jev-palvelun kutsuraja täyttyi.",
  overloaded: "Jev-palvelu on ylikuormitettu.",
  server: "Jev-palvelu palautti virheen.",
  timeout: "Jev-palvelu ei vastannut ajoissa.",
  network: "Yhteys Jev-palveluun epäonnistui.",
  "bad-response": "Jev-palvelun vastaus oli odottamattoman muotoinen.",
  aborted: "Pyyntö peruttiin.",
};

export class JevError extends Error {
  /** Palvelimen Retry-After-ohje millisekunteina (vain uusintayrityksen ajoitukseen). */
  retryAfterMs?: number;
  constructor(
    readonly kind: JevErrorKind,
    readonly status?: number,
  ) {
    super(`${MESSAGES[kind]}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "JevError";
  }
}

const RETRYABLE: JevErrorKind[] = ["rate-limit", "overloaded", "server", "timeout", "network"];

function statusToKind(status: number): JevErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 422) return "validation";
  if (status === 429) return "rate-limit";
  if (status === 529) return "overloaded";
  return "server";
}

export interface JevClientOptions {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs?: number;
  /** Uusintayritykset (ei sisällä ensimmäistä yritystä). */
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export class JevClient {
  private timeoutMs: number;
  private retries: number;
  private retryDelayMs: number;
  private fetchImpl: typeof fetch;

  constructor(private opts: JevClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.opts.model;
  }

  async ask(state: string, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResponse> {
    let last: JevError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (signal?.aborted) throw new JevError("aborted");
      if (attempt > 0 && this.retryDelayMs) {
        const wait = Math.min(last?.retryAfterMs ?? this.retryDelayMs * attempt, 3000);
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        return await this.once(state, questions, signal);
      } catch (e) {
        if (!(e instanceof JevError)) throw e;
        last = e;
        if (!RETRYABLE.includes(e.kind)) throw e;
      }
    }
    throw last!;
  }

  private async once(state: string, questions: Record<string, JevQuestion>, outer?: AbortSignal): Promise<JevResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onAbort = () => ctrl.abort();
    outer?.addEventListener("abort", onAbort);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({ model: this.opts.model, state, questions }),
          signal: ctrl.signal,
          cache: "no-store",
        });
      } catch {
        if (outer?.aborted) throw new JevError("aborted");
        throw new JevError(ctrl.signal.aborted ? "timeout" : "network");
      }
      if (!res.ok) {
        const err = new JevError(statusToKind(res.status), res.status);
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
        throw err;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new JevError("bad-response", res.status);
      }
      const parsed = JevResponseSchema.safeParse(body);
      if (!parsed.success) throw new JevError("bad-response", res.status);
      return parsed.data;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
}
