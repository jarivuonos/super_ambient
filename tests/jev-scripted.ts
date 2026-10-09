// Skriptattu Jev-jäljitelmä lauseluokittelun testeihin: vastaa lauseen tekstin perusteella.
import { vi } from "vitest";
import type { JevResponse } from "../lib/clinical/jev-client";
import type { SentenceKind, Timing } from "../lib/clinical/sentence-classifier";

export interface Script {
  kind?: SentenceKind;
  kindP?: number;
  negated?: number;
  relative?: number;
  hedged?: number;
  timing?: Timing;
  timingP?: number;
}

export function judgeResponse(s: Script = {}): JevResponse {
  const kind = s.kind ?? "other";
  const timing = s.timing ?? "unspecified";
  const kp = s.kindP ?? 0.95;
  const tp = s.timingP ?? 0.9;
  return {
    model: "jev-test",
    answers: {
      kind: { type: "choice", choice: kind, probabilities: { [kind]: kp }, confidence: kp },
      negated: { type: "noul", noul: s.negated ?? 0.05 },
      relative: { type: "noul", noul: s.relative ?? 0.05 },
      hedged: { type: "noul", noul: s.hedged ?? 0.05 },
      timing: { type: "choice", choice: timing, probabilities: { [timing]: tp }, confidence: tp },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

export function scriptedClient(script: Record<string, Script> | ((sentence: string) => Script | undefined)) {
  const calls: { state: Record<string, unknown>; questionKeys: string[] }[] = [];
  let inflight = 0;
  const stats = { maxInflight: 0 };
  const client = {
    model: "jev-test",
    ask: vi.fn(async (state: unknown, questions: Record<string, unknown>) => {
      const st = state as Record<string, unknown>;
      calls.push({ state: st, questionKeys: Object.keys(questions) });
      inflight++;
      stats.maxInflight = Math.max(stats.maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      const sentence = String(st.sentence);
      const sc = typeof script === "function" ? script(sentence) : script[sentence];
      if (!sc) throw new Error(`Ei skriptiä lauseelle: ${sentence}`);
      return judgeResponse(sc);
    }),
  };
  return { client, calls, stats };
}
