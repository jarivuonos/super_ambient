// Yhden äänitiedoston pisteytys: litteraatti vs. viite. Puhdasta logiikkaa (ei verkkoa).

import { mockStructure } from "../../lib/clinical/mock-structurer";
import { parsePastedTranscript } from "../../lib/clinical/transcript";
import type { AsrResult } from "../../lib/transcription/gemini-client";
import { align, compareKeys, negationScore, numberScore, speakerScore, tokenize, wordErrorRate, type Agreement, type CriticalScore, type SpeakerScore, type WerResult } from "./metrics";
import { referenceText, type Reference } from "./references";

export interface FileScore {
  wer: WerResult;
  negations: CriticalScore;
  numbers: CriticalScore;
  speakers: SpeakerScore | null;
  /** Montako eri puhujaa litteraatissa on (null, jos puhujatietoa ei ole) ja suurimman puhujan osuus sanoista. */
  speakerCount: number | null;
  dominantSpeakerShare: number | null;
  /** Mock-rakenteistuksen ehdotukset viitteestä vs. litteraatista (ei Jev-kutsuja). */
  agreement: Agreement;
}

/** Ehdotusavain: kohderesurssi|tyyppi|kohde|kielteisyys|arvo. Kohteeton ehdotus alkaa merkillä "-". */
export function proposalKeys(text: string): string[] {
  return mockStructure(parsePastedTranscript(text)).proposals.map((p) =>
    [p.targetResourceType ?? "-", p.type, p.subject, p.negation ? "neg" : "pos", JSON.stringify(p.value).toLocaleLowerCase("fi")].join("|"),
  );
}

/** Litteraatti puhuja-rooleiksi nimettyinä riveinä (rooli = puhujan tunnistettu vastine), muuten sellaisenaan. */
export function labelledHypothesis(result: AsrResult, mapping: Record<string, string> | undefined): string {
  if (!mapping || !result.words.some((w) => w.speaker !== undefined)) return result.text;
  const lines: string[] = [];
  let cur: string | undefined;
  for (const w of result.words) {
    const who = w.speaker === undefined ? "Tuntematon" : (mapping[w.speaker] ?? `Puhuja ${w.speaker}`);
    if (who !== cur) {
      lines.push(`${who}:`);
      cur = who;
    }
    lines[lines.length - 1] += ` ${w.text}`;
  }
  return lines.join("\n");
}

/**
 * `solo`: kaikki roolit luki yksi ääni. Silloin puhujapisteytys ohitetaan, ja ehdotukset vertaillaan ilman
 * rooleja, jotta puuttuvat roolit eivät näy virheinä; puhujamäärä kertoo silti, jakoiko palvelu yhden äänen useaksi.
 */
export function scoreTranscript(ref: Reference, result: AsrResult, lang: string, opts: { solo?: boolean } = {}): FileScore {
  const refTokens: string[] = [];
  const refWho: string[] = [];
  for (const t of ref.turns) {
    for (const tok of tokenize(t.text)) {
      refTokens.push(tok);
      refWho.push(t.who);
    }
  }

  const hypTokens: string[] = [];
  const hypSpeaker: (string | undefined)[] = [];
  if (result.words.length) {
    for (const w of result.words) {
      for (const tok of tokenize(w.text)) {
        hypTokens.push(tok);
        hypSpeaker.push(w.speaker);
      }
    }
  } else {
    for (const tok of tokenize(result.text)) {
      hypTokens.push(tok);
      hypSpeaker.push(undefined);
    }
  }

  const ops = align(refTokens, hypTokens);
  const speakers = opts.solo ? null : speakerScore(refWho, hypSpeaker, ops);
  const perSpeaker = new Map<string, number>();
  for (const w of result.words) if (w.speaker !== undefined) perSpeaker.set(w.speaker, (perSpeaker.get(w.speaker) ?? 0) + 1);
  const spoken = [...perSpeaker.values()].reduce((a, b) => a + b, 0);
  const refText = opts.solo ? ref.turns.map((t) => t.text).join("\n") : referenceText(ref);
  const hypText = opts.solo ? result.text || result.words.map((w) => w.text).join(" ") : labelledHypothesis(result, speakers?.mapping);
  return {
    wer: wordErrorRate(ops, refTokens.length, hypTokens.length),
    negations: negationScore(refTokens, hypTokens, ops, lang),
    numbers: numberScore(refTokens, hypTokens, ops),
    speakers,
    speakerCount: perSpeaker.size || null,
    dominantSpeakerShare: spoken ? Math.max(...perSpeaker.values()) / spoken : null,
    agreement: compareKeys(proposalKeys(refText), proposalKeys(hypText)),
  };
}
