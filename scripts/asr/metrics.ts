// Litteroinnin arviointimittarit (puhdasta logiikkaa, ei verkkoa): sanavirhesuhde, kriittiset sanat
// (numerot, kieltosanat) ja puhujien kohdistus. Käytetään vain koeajoskriptissä, ei sovelluksessa.

/** Numerot (myös 148/92, 38,5, 12.5.2026) pysyvät yhtenä merkkinä; sanat sisältävät tavuviivan ja heittomerkin. */
const TOKEN_RE = /\d+(?:[.,:/]\d+)*|\p{L}+(?:['’-]\p{L}+)*/gu;

export function tokenize(text: string): string[] {
  const found = text.toLocaleLowerCase("fi").normalize("NFC").match(TOKEN_RE) ?? [];
  return found.map((t) => (/^\d/.test(t) ? t.replace(/,/g, ".") : t));
}

export type Op = { op: "match" | "sub" | "del" | "ins"; ref?: number; hyp?: number };

const MAX_CELLS = 60_000_000;

/** Sanatason Levenshtein-kohdistus (korvaus, poisto ja lisäys maksavat 1). */
export function align(ref: string[], hyp: string[]): Op[] {
  const n = ref.length;
  const m = hyp.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) throw new Error("Litteraatit ovat liian pitkiä kohdistettaviksi.");
  const w = m + 1;
  const d = new Int32Array((n + 1) * w);
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    d[i * w] = i;
    for (let j = 1; j <= m; j++) {
      const diag = d[(i - 1) * w + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      d[i * w + j] = Math.min(diag, d[(i - 1) * w + j] + 1, d[i * w + j - 1] + 1);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * w + j] === d[(i - 1) * w + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? "match" : "sub", ref: i - 1, hyp: j - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i * w + j] === d[(i - 1) * w + j] + 1) {
      ops.push({ op: "del", ref: i - 1 });
      i--;
    } else {
      ops.push({ op: "ins", hyp: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

export interface WerResult {
  refWords: number;
  hypWords: number;
  matches: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** (S + D + I) / N; null, jos viitteessä ei ole sanoja. */
  wer: number | null;
}

export function wordErrorRate(ops: Op[], refWords: number, hypWords: number): WerResult {
  const count = (k: Op["op"]) => ops.filter((o) => o.op === k).length;
  const [matches, substitutions, deletions, insertions] = [count("match"), count("sub"), count("del"), count("ins")];
  return { refWords, hypWords, matches, substitutions, deletions, insertions, wer: refWords ? (substitutions + deletions + insertions) / refWords : null };
}

export const NEGATIONS: Record<string, ReadonlySet<string>> = {
  fi: new Set(["ei", "en", "et", "emme", "ette", "eivät", "eikä", "ettei", "ilman", "älä"]),
  sv: new Set(["inte", "ingen", "inget", "inga", "ej", "utan", "aldrig", "icke", "ingenting"]),
};

export interface CriticalScore {
  refCount: number;
  preserved: number;
  /** Litteraatissa oleva tällainen sana, jota viitteessä ei ole samassa kohdassa (esim. keksitty "ei"). */
  spurious: number;
}

function criticalScore(ref: string[], hyp: string[], ops: Op[], isCritical: (t: string) => boolean): CriticalScore {
  let refCount = 0;
  let preserved = 0;
  let spurious = 0;
  for (const o of ops) {
    if (o.ref !== undefined && isCritical(ref[o.ref])) {
      refCount++;
      if (o.op === "match") preserved++;
    }
    if (o.hyp !== undefined && o.op !== "match" && isCritical(hyp[o.hyp])) spurious++;
  }
  return { refCount, preserved, spurious };
}

/** Kieltosanat: pudonnut tai keksitty "ei" kääntää merkityksen, joten molemmat lasketaan. */
export function negationScore(ref: string[], hyp: string[], ops: Op[], lang: string): CriticalScore {
  const set = NEGATIONS[lang.slice(0, 2)] ?? NEGATIONS.fi;
  return criticalScore(ref, hyp, ops, (t) => set.has(t));
}

/** Numeroarvot (mittaukset, annokset, päivämäärät). */
export function numberScore(ref: string[], hyp: string[], ops: Op[]): CriticalScore {
  return criticalScore(ref, hyp, ops, (t) => /^\d/.test(t));
}

export interface SpeakerScore {
  /** Kohdistettujen sanojen määrä, joista puhuja voitiin verrata. */
  pairedWords: number;
  /** Osuus sanoista, joiden puhuja on oikea, kun jokainen litteraatin puhuja nimetään roolilla, jota se useimmin vastaa. */
  accuracy: number | null;
  mapping: Record<string, string>;
  confusion: Record<string, Record<string, number>>;
  /** Läheisen sanoista osuus, jotka päätyivät potilaaksi tulkitulle puhujalle (turvallisuuden kannalta tärkein virhe). */
  relativeAsPatientRate: number | null;
  /** Läheinen ja potilas ovat litteraatissa pääosin sama puhuja. */
  patientAndRelativeMerged: boolean | null;
}

function argmax(counts: Record<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) if (n > bestN) [best, bestN] = [k, n];
  return best;
}

/**
 * Puhujien kohdistus. `refWho[i]` on viitesanan i rooli ja `hypSpeaker[j]` litteraatin sanan j puhujatunniste.
 * Vertailu tehdään vain kohdistetuista sanoista (täsmäys tai korvaus).
 */
export function speakerScore(refWho: string[], hypSpeaker: (string | undefined)[], ops: Op[]): SpeakerScore | null {
  if (!hypSpeaker.some((s) => s !== undefined)) return null;
  const confusion: Record<string, Record<string, number>> = {};
  const bySpeaker: Record<string, Record<string, number>> = {};
  let paired = 0;
  for (const o of ops) {
    if (o.ref === undefined || o.hyp === undefined) continue;
    const who = refWho[o.ref];
    const spk = hypSpeaker[o.hyp];
    if (spk === undefined) continue;
    paired++;
    (confusion[who] ??= {})[spk] = (confusion[who][spk] ?? 0) + 1;
    (bySpeaker[spk] ??= {})[who] = (bySpeaker[spk][who] ?? 0) + 1;
  }
  const mapping: Record<string, string> = {};
  for (const spk of Object.keys(bySpeaker)) mapping[spk] = argmax(bySpeaker[spk]) ?? "?";
  let correct = 0;
  for (const [who, row] of Object.entries(confusion)) for (const [spk, n] of Object.entries(row)) if (mapping[spk] === who) correct += n;
  const relRow = confusion["Läheinen"];
  const relTotal = relRow ? Object.values(relRow).reduce((a, b) => a + b, 0) : 0;
  const relAsPatient = relRow ? Object.entries(relRow).reduce((a, [spk, n]) => a + (mapping[spk] === "Potilas" ? n : 0), 0) : 0;
  const dominantRel = relRow ? argmax(relRow) : null;
  const dominantPat = confusion["Potilas"] ? argmax(confusion["Potilas"]) : null;
  return {
    pairedWords: paired,
    accuracy: paired ? correct / paired : null,
    mapping,
    confusion,
    relativeAsPatientRate: relTotal ? relAsPatient / relTotal : null,
    patientAndRelativeMerged: dominantRel && dominantPat ? dominantRel === dominantPat : null,
  };
}

export interface Agreement {
  refProposals: number;
  hypProposals: number;
  /** Viitteestä löytyvät ehdotukset, jotka myös litteraatista syntyivät (täsmälleen samat). */
  recall: number | null;
  precision: number | null;
  missing: string[];
  extra: string[];
  /** Litteraatista syntyneet Observation/Condition-kohteet, joita viitteestä ei tullut (tallentuisivat väärin). */
  extraTargets: number;
}

/** Kahden avainlistan (monijoukko) vertailu. Avain alkaa kohderesurssilla tai merkillä "-". */
export function compareKeys(refKeys: string[], hypKeys: string[]): Agreement {
  const bag = (keys: string[]) => keys.reduce<Map<string, number>>((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
  const r = bag(refKeys);
  const h = bag(hypKeys);
  const missing: string[] = [];
  const extra: string[] = [];
  let common = 0;
  for (const [k, n] of r) {
    const c = Math.min(n, h.get(k) ?? 0);
    common += c;
    for (let i = 0; i < n - c; i++) missing.push(k);
  }
  for (const [k, n] of h) for (let i = 0; i < n - Math.min(n, r.get(k) ?? 0); i++) extra.push(k);
  return {
    refProposals: refKeys.length,
    hypProposals: hypKeys.length,
    recall: refKeys.length ? common / refKeys.length : null,
    precision: hypKeys.length ? common / hypKeys.length : null,
    missing,
    extra,
    extraTargets: extra.filter((k) => !k.startsWith("-|")).length,
  };
}
