// Litteraatin rakenteistus Jev-hybridinä.
//
// Työnjako: sovellus pilkkoo lauseet ja poimii lainaukset, mittausarvot ja termit (koodi),
// Jev luokittelee jokaisen lauseen (tyyppi, kielteisyys, kenestä, epävarmuus, ajankohta).
// Jev ei tuota tekstiä, arvoja eikä lähdeviitteitä, joten se ei voi keksiä mitään; pahimmillaan
// luokitus on väärä, ja ammattilaisen tarkistus ottaa sen kiinni.
//
// Varovaisuussäännöt: FHIR-kohde (Observation/Condition) annetaan vain, kun Jevin arvio on
// ratkaiseva (tyyppi, kielteisyys ja "kenestä" yli rajojen). Epävarma arvio jää ehdotukseksi,
// jota ei tallenneta ennen tarkistusta.

import { findKnownCondition } from "./codes";
import type { JevClient } from "./jev-client";
import { extractMeasurements, toMeasurementProposal, type MeasurementHit } from "./measurements";
import type { ModelProposal, NoteDraft, StructuringOutput, Transcript } from "./schemas";
import { SENTENCE_THRESHOLDS as T, classifySentence, type SentenceJudgement, type SentenceKind } from "./sentence-classifier";
import { splitTranscript, splitUnits, type Sentence } from "./sentences";
import { FAMILY_RE, YEAR_RE, describeSymptom, speakerLabel, suspectedTerm } from "./text-rules";
import { mapPool } from "../util/pool";

/** Enimmäismäärä Jevillä luokiteltavia lauseita yhdessä litteraatissa (kustannus- ja aikaraja). */
export const MAX_SENTENCES = 80;

export class StructuringLimitError extends Error {
  constructor(count: number, max: number) {
    super(`Litteraatissa on ${count} luokiteltavaa lausetta; Jev-rakenteistus sallii enintään ${max}. Lyhennä litteraattia tai käytä mock-tilaa.`);
    this.name = "StructuringLimitError";
  }
}

/** Luokitellaanko lause: kysymykset ja liian lyhyet vastaukset ("Ei.") ohitetaan. */
export function shouldClassify(s: Sentence): boolean {
  return !s.isQuestion && (s.text.match(/\p{L}/gu) ?? []).length >= 4;
}

export interface SentenceItem {
  sentence: Sentence;
  /** null = lausetta ei luokiteltu (liian lyhyt), mutta siitä poimitaan silti mittausarvot. */
  judgement: SentenceJudgement | null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const stripEnd = (s: string) => s.replace(/[.!?\s]+$/u, "");
const cap = (s: string) => (s ? s[0].toLocaleUpperCase("fi") + s.slice(1) : s);
/** Lauseen osa näytetään omana virkkeenään ("En ole oksentanut."); koko lause sellaisenaan. */
const display = (s: Sentence) => (s.parent ? `${cap(stripEnd(s.text))}.` : s.text);

/**
 * Mittausarvot poimitaan aina koko lauseesta (asiayhteys, esim. "RR", voi olla toisessa osassa), ja
 * kukin arvo liitetään siihen osaan, jonka sisällä se on. Paikat ovat suhteessa koko lauseeseen.
 */
export function unitHits(s: Sentence): MeasurementHit[] {
  const whole = s.parent ?? s;
  return extractMeasurements(whole.text).filter((h) => whole.start + h.relStart >= s.start && whole.start + h.relEnd <= s.end);
}

const sureYes = (p: number) => p >= T.flag;
const sureNo = (p: number) => p <= 1 - T.flag;

/** Puhdas funktio: lauseet + Jevin arviot → ehdotukset ja käyntimerkintäluonnos. */
export function buildStructuring(t: Transcript, items: SentenceItem[]): StructuringOutput {
  const proposals: ModelProposal[] = [];
  let pid = 0;
  const nextId = () => `p${++pid}`;
  const note: Record<keyof NoteDraft, string[]> = { reason: [], history: [], findings: [], assessment: [], plan: [] };
  const bps: ModelProposal[] = [];
  const temps: ModelProposal[] = [];
  let negatedFever: ModelProposal | undefined;
  let reasonFound = false;
  let firstSymptom: { s: Sentence; time: string | null } | undefined;

  const src = (s: Sentence, relStart = 0, relEnd = s.text.length) => {
    const start = s.start + relStart;
    const end = Math.min(s.start + relEnd, start + 1000); // skeema sallii enintään 1000 merkin lainauksen
    return { transcriptVersion: t.version, segmentId: s.seg.id, start, end, quote: s.seg.text.slice(start, end), speaker: s.seg.speaker };
  };

  const notedMeasured = new Set<Sentence>();
  for (const { sentence: s, judgement: j } of items) {
    const text = s.text;
    const whole = s.parent ?? s;
    const shown = display(s);
    const noteMeasured = () => {
      if (notedMeasured.has(whole)) return;
      notedMeasured.add(whole);
      note.findings.push(`Mitattu: ${whole.text}`);
    };
    if (!j) {
      // Esim. "RR 148/92": liian lyhyt luokiteltavaksi, mutta arvot poimitaan koodilla.
      const short = unitHits(s);
      for (const h of short) {
        const p = toMeasurementProposal(h, { proposalId: nextId(), source: src(whole, h.relStart, h.relEnd), subject: "potilas" });
        proposals.push(p);
        if (p.type === "bp") bps.push(p);
        if (p.type === "temperature") temps.push(p);
      }
      if (short.length) noteMeasured();
      continue;
    }
    const clinician = s.seg.speaker === "ammattilainen";
    const kindSure = j.kindP >= T.kind;
    const relative = sureYes(j.relative);
    const negated = sureYes(j.negated);
    const hedged = sureYes(j.hedged);
    const isFamily = j.kind === "family";
    const unsure: string[] = [];
    if (!kindSure) unsure.push("Jev ei ollut varma lauseen tyypistä.");
    if (!isFamily && !relative && !sureNo(j.relative)) unsure.push("Jev ei ollut varma, koskeeko tieto potilasta vai jotakuta muuta.");
    if (!negated && !sureNo(j.negated)) unsure.push("Jev ei ollut varma, onko asia kielletty.");
    const decisive = unsure.length === 0;
    const certainty: ModelProposal["certainty"] = unsure.length || (hedged && j.kind !== "assessment") ? "tulkinnanvarainen" : "suora";
    const subject: ModelProposal["subject"] = isFamily || relative ? "läheinen" : "potilas";
    const past = j.timing === "past" && j.timingP >= T.timing;
    const temporality = j.timingP >= T.timing ? (j.timing === "current" ? "nykyinen" : j.timing === "past" ? "aiempi" : j.timing === "future" ? "tuleva" : null) : null;
    const extraIssues = [...unsure, ...(hedged && j.kind !== "assessment" ? ["Epävarma ilmaisu."] : []), ...(relative && !isFamily ? ["Tieto koskee läheistä, ei potilasta."] : [])];

    const mk = (
      type: ModelProposal["type"],
      valueText: string,
      o: {
        certainty?: ModelProposal["certainty"];
        issues?: string[];
        subject?: ModelProposal["subject"];
        negation?: boolean;
        temporality?: string | null;
        coding?: ModelProposal["codingCandidate"];
        target?: ModelProposal["targetResourceType"];
        verification?: ModelProposal["value"]["verificationStatus"];
        source?: ModelProposal["source"];
      } = {},
    ): ModelProposal => {
      const p: ModelProposal = {
        proposalId: nextId(),
        type,
        value: { text: clip(valueText, 1000), bp: null, quantity: null, verificationStatus: o.verification ?? null },
        source: o.source ?? src(s),
        certainty: o.certainty ?? certainty,
        issues: o.issues ?? extraIssues,
        subject: o.subject ?? subject,
        negation: o.negation ?? negated,
        temporality: o.temporality === undefined ? temporality : o.temporality,
        codingCandidate: o.coding ?? null,
        targetResourceType: o.target ?? null,
      };
      proposals.push(p);
      return p;
    };
    const historyLine = () => note.history.push(`${speakerLabel(s.seg.speaker)} kertoo: ${shown}`);

    // --- Mittaukset: arvot koodista; Jev vain arvioi yhteyttä ---
    const hits = unitHits(s);
    for (const h of hits) {
      const p = toMeasurementProposal(h, { proposalId: nextId(), source: src(whole, h.relStart, h.relEnd), subject });
      if (kindSure && j.kind !== "measurement") {
        if (p.certainty === "suora") p.certainty = "tulkinnanvarainen";
        p.issues.push("Jev ei tulkinnut lausetta mittaukseksi; tarkista.");
      }
      if (!kindSure) p.issues.push("Jev ei ollut varma lauseen tyypistä.");
      if (relative) p.issues.push("Tieto koskee läheistä, ei potilasta.");
      if (past) {
        p.targetResourceType = null;
        p.temporality = "aiempi";
        p.issues.push("Mittaus näyttää olevan aiemmalta ajalta; ei tallenneta tämän käynnin havaintona.");
      }
      proposals.push(p);
      if (p.type === "bp") bps.push(p);
      if (p.type === "temperature") temps.push(p);
    }
    if (hits.length) noteMeasured();

    // --- Tyypin mukainen käsittely ---
    switch (j.kind) {
      case "reason":
        mk("reason", shown, { target: null });
        note.reason.push(shown);
        reasonFound = true;
        break;

      case "symptom": {
        const d = describeSymptom(text, negated);
        const p = mk("symptom", d?.text ?? stripEnd(shown), {
          issues: [...extraIssues, ...(negated ? ["Kielteinen löydös kirjataan käyntimerkintään; sitä ei tallenneta Condition-resurssina."] : [])],
          temporality: d?.time ?? temporality,
          target: decisive && !negated && !relative && !hedged ? "Condition" : null,
        });
        if (negated && /kuume/iu.test(text)) negatedFever = p;
        if (!firstSymptom && decisive && !negated && !relative && !clinician) firstSymptom = { s, time: d?.time ?? null };
        historyLine();
        break;
      }

      case "finding":
        note.findings.push(`Todettu: ${shown}`);
        break;

      case "measurement":
        if (!hits.length) note.findings.push(`Mitattu: ${shown}`);
        break;

      case "history": {
        if (relative) {
          // Läheisen sairaus ei ole potilaan sairaus, vaikka tyyppi olisi luokiteltu historiaksi.
          const known = findKnownCondition(text);
          mk("family-history", known ? `Sukuanamneesi: ${known.fi.toLowerCase()}` : `Sukuanamneesi: ${stripEnd(shown)}`, {
            subject: "läheinen",
            coding: known?.coding ?? null,
            issues: ["Tieto koskee läheistä, ei potilasta.", ...unsure],
          });
          historyLine();
          break;
        }
        const known = findKnownCondition(text);
        mk("condition", known ? (negated ? `Ei ${known.fi.toLowerCase()}` : known.fi) : stripEnd(shown), {
          certainty: "tulkinnanvarainen",
          issues: ["Keskustelussa mainittu aiempi diagnoosi; varmista ennen tallennusta.", ...extraIssues],
          verification: negated ? null : "unconfirmed",
          temporality: temporality ?? "aiempi/nykyinen",
          coding: known?.coding ?? null,
          target: known && decisive && !negated ? "Condition" : null,
        });
        historyLine();
        break;
      }

      case "medication":
        mk("medication-mention", shown, { issues: ["Lääkitystä ei määrätä eikä lääkelistaa päivitetä tässä versiossa.", ...extraIssues] });
        historyLine();
        break;

      case "allergy":
        mk("allergy-mention", shown, { issues: ["Allergialistaa ei päivitetä automaattisesti; tieto kirjataan käyntimerkintään.", ...extraIssues] });
        historyLine();
        break;

      case "procedure": {
        const year = YEAR_RE.exec(text)?.[2];
        mk("procedure-history", shown, { temporality: year ? `vuonna ${year}` : (temporality ?? "aiempi") });
        historyLine();
        break;
      }

      case "assessment": {
        const sus = suspectedTerm(text);
        const known = findKnownCondition(sus?.term ?? text);
        if (!negated && !relative && (sus || known)) {
          const term = known?.fi ?? sus!.term;
          const provisional = hedged || !!sus;
          mk("condition", provisional ? `${term} (epäily)` : term, {
            certainty: unsure.length || !clinician ? "tulkinnanvarainen" : "suora",
            issues: [
              provisional ? "Diagnoosiepäily, ei varmistettu diagnoosi." : "Mainittu diagnoosi; ei varmistettu.",
              ...(clinician ? [] : ["Epäilyn esittäjä ei ole tunnistettu ammattilaiseksi."]),
              ...(known ? [] : ["Koodia ei löytynyt tunnetusta luettelosta; tallennetaan tekstinä."]),
              ...unsure,
            ],
            subject: "potilas",
            negation: false,
            temporality: temporality ?? "nykyinen",
            verification: provisional ? "provisional" : "unconfirmed",
            coding: known?.coding ?? null,
            target: unsure.length === 0 ? "Condition" : null,
            source: sus ? src(s, sus.index, sus.end) : undefined,
          });
        } else {
          mk("assessment", shown, { certainty: unsure.length ? "tulkinnanvarainen" : "suora", issues: extraIssues, temporality: temporality ?? "nykyinen" });
        }
        note.assessment.push(clinician ? `Ammattilaisen arvio keskustelussa: ${shown}` : `${speakerLabel(s.seg.speaker)}: ${shown}`);
        break;
      }

      case "plan":
        mk("plan", shown, {
          certainty: clinician && !unsure.length ? "suora" : "tulkinnanvarainen",
          issues: ["Suunnitelma kirjataan käyntimerkintään; tilauksia ei tehdä tässä versiossa.", ...unsure, ...(clinician ? [] : ["Suunnitelman esittäjä ei ole tunnistettu ammattilaiseksi."])],
          temporality: "tuleva",
          negation: false,
        });
        note.plan.push(shown);
        break;

      case "family": {
        const known = findKnownCondition(text);
        const rel = (FAMILY_RE.exec(text)?.[0] ?? "läheinen").toLowerCase();
        mk("family-history", known ? `Sukuanamneesi: ${known.fi.toLowerCase()} (${rel})` : `Sukuanamneesi: ${stripEnd(shown)}`, {
          subject: "läheinen",
          coding: known?.coding ?? null,
          issues: ["Tieto koskee läheistä, ei potilasta.", ...unsure],
        });
        historyLine();
        break;
      }

      case "other":
        break;
    }
  }

  // Käynnin syy päätellään ensimmäisestä potilaan kertomasta oireesta, jos sitä ei sanottu suoraan.
  if (!reasonFound && firstSymptom) {
    const s = firstSymptom.s;
    proposals.push({
      proposalId: nextId(),
      type: "reason",
      value: { text: clip(display(s), 1000), bp: null, quantity: null, verificationStatus: null },
      source: src(s),
      certainty: "tulkinnanvarainen",
      issues: ["Käynnin syy on päätelty ensimmäisestä potilaan kertomasta oireesta."],
      subject: "potilas",
      negation: false,
      temporality: firstSymptom.time,
      codingCandidate: null,
      targetResourceType: null,
    });
    note.reason.push(display(s));
  }

  // Ristiriidat: "ei kuumetta" ja kuumetasoinen lämpöarvo.
  if (negatedFever) {
    for (const tp of temps) {
      if ((tp.value.quantity?.value ?? 0) >= 37.5) {
        tp.certainty = "ristiriitainen";
        tp.issues.push("Keskustelussa todetaan myös 'ei kuumetta'.");
        negatedFever.certainty = "ristiriitainen";
        negatedFever.issues.push(`Keskustelussa mainitaan lämpö ${tp.value.text}.`);
      }
    }
  }
  if (bps.length > 1) for (const b of bps) b.issues.push(`Käynnillä ${bps.length} verenpainemittausta; tarkista, mitkä tallennetaan.`);

  return {
    note: {
      reason: note.reason.join("\n"),
      history: note.history.join("\n"),
      findings: note.findings.join("\n"),
      assessment: note.assessment.join("\n"),
      plan: note.plan.join("\n"),
    },
    proposals,
  };
}

export interface StructureDiagnostics {
  source: "jev-structuring";
  model: string | null;
  sentences: number;
  /** Luokiteltavia yksikköjä lauseiden jaon jälkeen (>= lauseita). */
  units: number;
  classified: number;
  skippedQuestions: number;
  skippedShort: number;
  byKind: Partial<Record<SentenceKind, number>>;
  /** Montako arviota jäi alle varmuusrajojen (näistä ei tehdä FHIR-kohdetta). */
  unsure: { kind: number; negated: number; relative: number; hedged: number };
  usage: { inputTokens: number; outputTokens: number };
  concurrency: number;
  maxSentences: number;
  thresholds: typeof T;
}

export async function structureWithJev(
  client: Pick<JevClient, "ask"> & { model?: string },
  t: Transcript,
  opts: { concurrency?: number; maxSentences?: number; signal?: AbortSignal; onDiagnostics?: (d: StructureDiagnostics) => void } = {},
): Promise<StructuringOutput> {
  const concurrency = opts.concurrency ?? 1;
  const maxSentences = opts.maxSentences ?? MAX_SENTENCES;
  const sentences = splitTranscript(t);
  const units = splitUnits(t); // lauseet jaettuna osiin varmoista erottimista (mutta, vaikka, ;)
  const classifiable = units.filter(shouldClassify);
  if (classifiable.length > maxSentences) throw new StructuringLimitError(classifiable.length, maxSentences);

  const results = await mapPool(classifiable, concurrency, (s) => classifySentence(client, t, s, opts.signal));
  const judged = new Map<Sentence, SentenceJudgement>(classifiable.map((s, i) => [s, results[i].judgement]));
  // Alkuperäinen järjestys säilyy: luokiteltujen lisäksi lyhyet lauseet, joissa on mittausarvo.
  const items: SentenceItem[] = units
    .filter((s) => judged.has(s) || (!s.isQuestion && unitHits(s).length > 0))
    .map((sentence) => ({ sentence, judgement: judged.get(sentence) ?? null }));

  const byKind: StructureDiagnostics["byKind"] = {};
  const unsure = { kind: 0, negated: 0, relative: 0, hedged: 0 };
  const between = (p: number) => !sureYes(p) && !sureNo(p);
  for (const j of results.map((r) => r.judgement)) {
    byKind[j.kind] = (byKind[j.kind] ?? 0) + 1;
    if (j.kindP < T.kind) unsure.kind++;
    if (between(j.negated)) unsure.negated++;
    if (between(j.relative)) unsure.relative++;
    if (between(j.hedged)) unsure.hedged++;
  }
  opts.onDiagnostics?.({
    source: "jev-structuring",
    model: client.model ?? null,
    sentences: sentences.length,
    units: units.length,
    classified: classifiable.length,
    skippedQuestions: sentences.filter((s) => s.isQuestion).length,
    skippedShort: units.filter((s) => !s.isQuestion && !shouldClassify(s)).length,
    byKind,
    unsure,
    usage: {
      inputTokens: results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0),
      outputTokens: results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0),
    },
    concurrency,
    maxSentences,
    thresholds: T,
  });
  return buildStructuring(t, items);
}
