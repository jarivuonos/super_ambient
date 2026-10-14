// Litteraatin rakenteistuksen arviointi synteettisellä kultajoukolla: mock vs. Jev-hybridi.
//
//   bun run eval:structure                 vain mock (ei verkkoyhteyksiä)
//   bun run eval:structure -- --jev        lisäksi Jev (TYPESAFE_API_KEY ympäristöstä)
//                                          ~120 pientä kutsua, peräkkäin; LÄHETTÄÄ synteettisten lauseiden tekstit Typesafelle
//
// Skripti ei tulosta avainta. Pisteytys tehdään luokiteltavien yksiköiden tasolla (lause tai sen osa,
// kun lause on jaettu sanoista mutta/vaikka tai puolipisteestä). Mittarit:
//  - tyyppi / kielteisyys / kenestä / epäröinti,
//  - TURVALLISUUS: ehdotukset, joilla on FHIR-kohde (Observation/Condition), vaikka kultajoukon mukaan
//    yksikkö on kielteinen, koskee muuta henkilöä tai ei ole tallennettavaa tyyppiä ("vaarallinen kohde"),
//  - varovaisuuden hinta: myönteiset potilaan oireet, joille ei annettu kohdetta.
//
// Mockia pisteytetään yhdistelmälauseissa anteliaasti: osa katsotaan oikeaksi, jos jokin lauseen
// ehdotuksista vastaa kultaa (mock ei jaa lauseita osiin).

import { JevClient, JevError } from "../lib/clinical/jev-client";
import { buildStructuring, shouldClassify, unitHits, type SentenceItem } from "../lib/clinical/jev-structurer";
import { mockStructure } from "../lib/clinical/mock-structurer";
import type { ModelProposal, StructuringOutput } from "../lib/clinical/schemas";
import { classifySentence, SENTENCE_THRESHOLDS, type SentenceJudgement, type SentenceKind } from "../lib/clinical/sentence-classifier";
import { splitUnits, type Sentence } from "../lib/clinical/sentences";
import { parsePastedTranscript } from "../lib/clinical/transcript";
import { readJevSettings } from "../lib/jev-settings";
import { finalizeStructuring } from "../lib/workflow/review";
import { GOLD, goldTranscriptText, type Gold } from "../lib/clinical/sample-conversations";

const useJev = process.argv.includes("--jev");
const SPEAKER = { Lääkäri: "ammattilainen", Potilas: "potilas", Läheinen: "läheinen" } as const;

interface Pred {
  kind: SentenceKind;
  neg: boolean;
  rel: boolean;
  hedge: boolean;
  kindP?: number;
}
interface Row {
  text: string;
  gold: Gold;
  compound: boolean;
  pred: Pred;
  targets: ModelProposal["targetResourceType"][];
}

const KIND_OF_TYPE: Partial<Record<ModelProposal["type"], SentenceKind>> = {
  symptom: "symptom",
  reason: "symptom",
  bp: "measurement",
  "heart-rate": "measurement",
  temperature: "measurement",
  "medication-mention": "medication",
  "allergy-mention": "allergy",
  "procedure-history": "procedure",
  assessment: "assessment",
  "family-history": "family",
  plan: "plan",
};

const overlapping = (s: Sentence, proposals: ModelProposal[]) =>
  proposals.filter((p) => p.source.segmentId === s.seg.id && p.source.start < s.end && p.source.end > s.start);

function predOf(props: ModelProposal[]): Pred {
  const first = props.find((p) => p.type !== "reason") ?? props[0];
  let kind: SentenceKind = "other";
  if (first) kind = first.type === "condition" ? (first.value.verificationStatus === "provisional" ? "assessment" : "history") : (KIND_OF_TYPE[first.type] ?? "other");
  return {
    kind,
    neg: props.some((p) => p.negation),
    rel: props.some((p) => p.subject !== "potilas"),
    hedge: props.some((p) => p.value.verificationStatus === "provisional" || /epäily/iu.test(p.value.text)),
  };
}

const matches = (g: Gold, p: Pred) => accepts(g, p.kind) && p.neg === !!g.neg && p.rel === !!g.rel && p.hedge === !!g.hedge;
const accepts = (g: Gold, kind: SentenceKind) => kind === g.kind || (g.alt ?? []).includes(kind);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)} %` : "–");

/** Mockin tulos yksikölle. Yhdistelmälauseessa valitaan lauseen ehdotuksista kultaa parhaiten vastaava. */
function mockRow(u: Sentence, gold: Gold, out: StructuringOutput, proposals: ModelProposal[]): Row {
  const props = overlapping(u, proposals);
  if (!u.parent) {
    let pred = predOf(props);
    if (!props.length) {
      if (out.note.findings.includes(`Todettu: ${u.text}`)) pred = { ...pred, kind: "finding" };
      else if (out.note.findings.includes(`Mitattu: ${u.text}`)) pred = { ...pred, kind: "measurement" };
    }
    return { text: u.text, gold, compound: false, pred, targets: props.map((p) => p.targetResourceType) };
  }
  const cands = props.map((p) => ({ p, pred: predOf([p]) }));
  const best = cands.find((c) => matches(gold, c.pred)) ?? cands[0];
  return { text: u.text, gold, compound: true, pred: best?.pred ?? { kind: "other", neg: false, rel: false, hedge: false }, targets: best ? [best.p.targetResourceType] : [] };
}

function jevPred(j: SentenceJudgement | null): Pred {
  if (!j) return { kind: "other", neg: false, rel: false, hedge: false };
  return { kind: j.kind, neg: j.negated > 0.5, rel: j.relative > 0.5, hedge: j.hedged > 0.5, kindP: j.kindP };
}

function report(name: string, rows: Row[], extra?: () => void) {
  const n = rows.length;
  const acc = (f: (r: Row) => boolean, set = rows) => `${pct(set.filter(f).length, set.length)}`;
  console.log(`\n=== ${name} (${n} yksikköä; ${rows.filter((r) => r.compound).length} yhdistelmälauseen osaa) ===`);
  console.log(`tyyppi ${acc((r) => accepts(r.gold, r.pred.kind))} · kielteisyys ${acc((r) => r.pred.neg === !!r.gold.neg)} · kenestä ${acc((r) => r.pred.rel === !!r.gold.rel)} · epäröinti ${acc((r) => r.pred.hedge === !!r.gold.hedge)}`);
  const comp = rows.filter((r) => r.compound);
  if (comp.length) console.log(`  yhdistelmälauseiden osat: tyyppi ${acc((r) => accepts(r.gold, r.pred.kind), comp)} · kielteisyys ${acc((r) => r.pred.neg === !!r.gold.neg, comp)} · kaikki oikein ${acc((r) => matches(r.gold, r.pred), comp)}`);

  const safeKinds: SentenceKind[] = ["symptom", "history", "assessment", "measurement", "reason"];
  const allowsTarget = (g: Gold) => [g.kind, ...(g.alt ?? [])].some((k) => safeKinds.includes(k));
  const unsafe = rows.filter((r) => r.targets.some(Boolean) && (r.gold.neg || r.gold.rel || !allowsTarget(r.gold)));
  const viaAlt = rows.filter((r) => r.targets.some(Boolean) && !r.gold.neg && !r.gold.rel && !safeKinds.includes(r.gold.kind) && allowsTarget(r.gold));
  const lost = rows.filter((r) => r.gold.kind === "symptom" && !r.gold.neg && !r.gold.rel && !r.gold.hedge && !r.targets.some(Boolean));
  const positive = rows.filter((r) => r.gold.kind === "symptom" && !r.gold.neg && !r.gold.rel && !r.gold.hedge).length;
  console.log(`VAARALLISET kohteet (FHIR-kohde kielteiselle/läheisen/ei-tallennettavalle): ${unsafe.length}`);
  for (const r of unsafe) console.log(`   ⚠ "${r.text}"  gold=${r.gold.kind}${r.gold.neg ? " neg" : ""}${r.gold.rel ? " rel" : ""}  kohde=${r.targets.filter(Boolean).join(",")}`);
  for (const r of viaAlt) console.log(`   ℹ "${r.text}"  gold=${r.gold.kind} (hyväksytty vaihtoehto ${r.gold.alt?.join("/")}); kohde=${r.targets.filter(Boolean).join(",")} – ei lasketa vaaralliseksi`);
  console.log(`varovaisuuden hinta: ${lost.length}/${positive} myönteistä potilaan oiretta ilman kohdetta`);

  for (const r of rows) {
    const bad: string[] = [];
    if (!accepts(r.gold, r.pred.kind)) bad.push(`tyyppi ${r.gold.kind} → ${r.pred.kind}${r.pred.kindP !== undefined ? ` (p=${r.pred.kindP.toFixed(2)})` : ""}`);
    if (r.pred.neg !== !!r.gold.neg) bad.push(`kielteisyys ${!!r.gold.neg} → ${r.pred.neg}`);
    if (r.pred.rel !== !!r.gold.rel) bad.push(`kenestä ${!!r.gold.rel} → ${r.pred.rel}`);
    if (r.pred.hedge !== !!r.gold.hedge) bad.push(`epäröinti ${!!r.gold.hedge} → ${r.pred.hedge}`);
    if (bad.length) console.log(`  ✗ ${r.compound ? "[osa] " : ""}"${r.text}"  [${bad.join("; ")}]`);
  }
  extra?.();
}

const mockRows: Row[] = [];
const jevRows: Row[] = [];
let ms: number[] = [];
let tokens = 0;
const abstain = { kind: 0, flags: 0 };

let client: JevClient | undefined;
if (useJev) {
  const settings = readJevSettings(process.env);
  if (!settings.ok) {
    console.error(`Jev-ajoa ei voi tehdä: ${settings.reason}`);
    process.exit(1);
  }
  client = new JevClient({ ...settings.settings });
}

outer: for (const g of GOLD) {
  const t = parsePastedTranscript(goldTranscriptText(g));
  const units = splitUnits(t);
  const goldByUnit = new Map<Sentence, Gold>();
  for (const u of units) {
    const whole = u.parent ?? u;
    const line = g.lines.find((l) => l.text === whole.text && SPEAKER[l.who] === u.seg.speaker);
    const gold = u.parent ? line?.clauses?.find((c) => c.text === u.text)?.gold : line?.gold;
    if (gold) goldByUnit.set(u, gold);
  }

  // --- mock ---
  const out = mockStructure(t);
  const fin = finalizeStructuring(out, t);
  for (const [u, gold] of goldByUnit) mockRows.push(mockRow(u, gold, out, fin.proposals));

  // --- Jev ---
  if (!client) continue;
  const items: SentenceItem[] = [];
  const judgements = new Map<Sentence, SentenceJudgement | null>();
  for (const u of units) {
    if (u.isQuestion) continue;
    if (!shouldClassify(u)) {
      if (unitHits(u).length) {
        judgements.set(u, null);
        items.push({ sentence: u, judgement: null });
      }
      continue;
    }
    const t0 = Date.now();
    try {
      const { judgement, usage } = await classifySentence(client, t, u);
      ms.push(Date.now() - t0);
      tokens += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
      judgements.set(u, judgement);
      items.push({ sentence: u, judgement });
      if (judgement.kindP < SENTENCE_THRESHOLDS.kind) abstain.kind++;
      if ([judgement.negated, judgement.relative, judgement.hedged].some((p) => p > 1 - SENTENCE_THRESHOLDS.flag && p < SENTENCE_THRESHOLDS.flag)) abstain.flags++;
    } catch (e) {
      const err = e instanceof JevError ? e : new JevError("network");
      console.error(`Jev-virhe (${err.message}); keskeytetään.`);
      break outer;
    }
  }
  const built = finalizeStructuring(buildStructuring(t, items), t);
  for (const [u, gold] of goldByUnit) {
    jevRows.push({ text: u.text, gold, compound: !!u.parent, pred: jevPred(judgements.get(u) ?? null), targets: overlapping(u, built.proposals).map((p) => p.targetResourceType) });
  }
}

report("MOCK (sääntöpohjainen)", mockRows);
if (!useJev) {
  console.log("\nJev-ajo ohitettu. `bun run eval:structure -- --jev` lähettää synteettisten lauseiden tekstit Typesafelle luokiteltaviksi.");
  process.exit(0);
}
report(`JEV-hybridi (${client?.model})`, jevRows, () => {
  ms = ms.sort((a, b) => a - b);
  if (ms.length) console.log(`viive/yksikkö: mediaani ${ms[Math.floor(ms.length / 2)]} ms · suurin ${ms[ms.length - 1]} ms · tokeneita ${tokens}`);
  console.log(`epävarmoja arvioita (ei kohdetta): tyyppi ${abstain.kind}, kyllä/ei-arvio ${abstain.flags} (rajat: tyyppi ${SENTENCE_THRESHOLDS.kind}, kyllä/ei ${SENTENCE_THRESHOLDS.flag})`);
});
