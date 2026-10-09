import type { Transcript, TranscriptSegment } from "./schemas";

export interface Sentence {
  seg: TranscriptSegment;
  /** Merkkikohdat puheenvuoron tekstissä. */
  start: number;
  end: number;
  text: string;
  isQuestion: boolean;
  /** Jos tämä on lauseen osa (lauseke): koko lause ja osan järjestysnumero. */
  parent?: Sentence;
  clauseIndex?: number;
}

const QUESTION_WORD_RE = /^(onko|onks|oliko|mikä|mitä|miten|milloin|kuinka|missä|käytätkö|onko teillä)\b/iu;

export function splitSentences(seg: TranscriptSegment): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^.!?]+[.!?]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg.text))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) continue;
    const start = m.index + lead;
    out.push({ seg, start, end: start + text.length, text, isQuestion: text.endsWith("?") || QUESTION_WORD_RE.test(text) });
  }
  return out;
}

export function splitTranscript(t: Transcript): Sentence[] {
  return t.segments.flatMap(splitSentences);
}

// Lauseen jako osiin, joilla voi olla vastakkainen kielteisyys ("Pahoinvointia on ollut, mutta en ole
// oksentanut."). Jaetaan vain varmoista erottimista; "ja" on liian monitulkintainen säännöksi.
const CLAUSE_SPLIT = /\s*;\s*|,?\s+(?:mutta|vaikka)(?!\p{L})\s+/giu;
// Sanoina lasketaan myös luvut: "uusinta 145/90" on kokonainen osa.
const wordCount = (s: string) => (s.match(/[\p{L}\d]+/gu) ?? []).length;

/** Jakaa lauseen osiin. Jos jokin osa jäisi alle kahden sanan (tai luvun), lausetta ei jaeta. */
export function splitClauses(s: Sentence): Sentence[] {
  if (s.isQuestion) return [s];
  const parts: { start: number; end: number }[] = [];
  let from = 0;
  for (const m of s.text.matchAll(CLAUSE_SPLIT)) {
    parts.push({ start: from, end: m.index });
    from = m.index + m[0].length;
  }
  if (!parts.length) return [s];
  parts.push({ start: from, end: s.text.length });
  const trimmed = parts.map((p) => {
    const raw = s.text.slice(p.start, p.end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    return { start: p.start + lead, end: p.start + lead + text.length, text };
  });
  if (trimmed.some((p) => wordCount(p.text) < 2)) return [s];
  return trimmed.map((p, i) => ({
    seg: s.seg,
    start: s.start + p.start,
    end: s.start + p.end,
    text: p.text,
    isQuestion: false,
    parent: s,
    clauseIndex: i,
  }));
}

/** Luokiteltavat yksiköt: lauseet, jotka on jaettu osiin varmoista erottimista. */
export function splitUnits(t: Transcript): Sentence[] {
  return splitTranscript(t).flatMap(splitClauses);
}
