// Sääntöpohjainen MOCK-rakenteistaja. Tämä EI ole kielimalli: se tunnistaa vain
// rajatun joukon suomenkielisiä ilmauksia, jotta demo ja hyväksymistestit toimivat
// ilman mallipalvelua. Tulos kulkee saman skeemavalidoinnin ja tarkistuksen läpi kuin
// oikean mallin vastaus.

import { findKnownCondition } from "./codes";
import { extractMeasurements, toMeasurementProposal } from "./measurements";
import type { ModelProposal, NoteDraft, StructuringOutput, Transcript } from "./schemas";
import { splitSentences, type Sentence } from "./sentences";
import { FAMILY_RE, L, NE, SUSPECT_RE, SYMPTOMS, TIME_RE, YEAR_RE, findLocation, negatedBefore, speakerLabel } from "./text-rules";

const ASSESS_RE = /(epäil|arvioni|arvioisin|vaikuttaa|todennäköi|mahdollisesti|kyseessä|sopii|viittaa)/iu;
const PLAN_RE = /(otetaan|otamme|lähetän|lähete|kontrolli|seuranta|seurataan|jatkoarvi|aloitetaan|aloitan|määrään|ohjaan|varataan|varaan|soita|uusi käynti|päivystykseen|tilataan|tilaan)/iu;
const MED_DOSE_RE = new RegExp(`(${L}{4,})\\s+(\\d+(?:[,.]\\d+)?)\\s*(mg|µg|mcg|g|ml|ky)${NE}`, "iu");
const MED_RE = /(käytän|käyttää|käytössä|lääkity|lääke|lääkkee|tabletti|otan|syön\s+\p{L}+(?:a|ä)\b)/iu;
const ALLERGY_RE = /(allergi|yliherk|tulee ihottum|ei sovi|ei siedä)/iu;
const NO_ALLERGY_RE = /(ei\s+(ole\s+)?(tiedossa\s+olevia\s+)?allergi|ei\s+lääkeallergi)/iu;
const PROC_RE = /(leikattu|leikkaus|leikattiin|operoitu|toimenpide|poistettu|poistettiin)/iu;
const FINDING_RE = /(palpaatioarka|aristaa|arista|aristus|kuultu|auskult|todetaan|statuksessa|iho on|on punoit|turvotus)/iu;

export function mockStructure(t: Transcript): StructuringOutput {
  const proposals: ModelProposal[] = [];
  let pid = 0;
  const nextId = () => `p${++pid}`;
  const src = (s: Sentence, relStart = 0, relEnd = s.text.length) => {
    const start = s.start + relStart;
    const end = s.start + relEnd;
    return {
      transcriptVersion: t.version,
      segmentId: s.seg.id,
      start,
      end,
      quote: s.seg.text.slice(start, end),
      speaker: s.seg.speaker,
    };
  };

  const note: Record<keyof NoteDraft, string[]> = { reason: [], history: [], findings: [], assessment: [], plan: [] };
  const sentences = t.segments.flatMap(splitSentences);
  let reasonFound = false;
  let negatedFever: ModelProposal | undefined;
  const temps: ModelProposal[] = [];
  const bps: ModelProposal[] = [];

  for (const s of sentences) {
    if (s.isQuestion) continue; // Kysymykset eivät ole todettuja tietoja.
    const text = s.text;
    const family = FAMILY_RE.test(text);
    const subject = family ? ("läheinen" as const) : ("potilas" as const);
    const clinician = s.seg.speaker === "ammattilainen";
    let consumed = false; // onko lause jo luokiteltu muistiinpanoon

    // --- Mittaukset ---
    const hits = extractMeasurements(text);
    for (const h of hits) {
      const p = toMeasurementProposal(h, { proposalId: nextId(), source: src(s, h.relStart, h.relEnd), subject });
      if (p.type === "bp") bps.push(p);
      if (p.type === "temperature") temps.push(p);
      proposals.push(p);
    }
    const hasVital = hits.length > 0;
    if (hasVital) {
      note.findings.push(`Mitattu: ${text}`);
      consumed = true;
    }

    // --- Ongelmat, diagnoosiepäilyt ja sukuanamneesi ---
    const suspect = SUSPECT_RE.exec(text);
    const known = findKnownCondition(text);
    let conditionMade = false;
    if (family && known) {
      const rel = (FAMILY_RE.exec(text)?.[0] ?? "läheinen").toLowerCase();
      proposals.push({
        proposalId: nextId(),
        type: "family-history",
        value: { text: `Sukuanamneesi: ${known.fi.toLowerCase()} (${rel})`, bp: null, quantity: null, verificationStatus: null },
        source: src(s),
        certainty: "suora",
        issues: ["Tieto koskee läheistä, ei potilasta."],
        subject: "läheinen",
        negation: false,
        temporality: null,
        codingCandidate: known.coding,
        targetResourceType: null,
      });
      note.history.push(`${speakerLabel(s.seg.speaker)} kertoo: ${text}`);
      consumed = true;
      conditionMade = true;
    } else if (suspect && !family) {
      const term = suspect[2].trim().replace(/\s+(ja|sekä|tai)\s.*$/iu, "");
      const kc = findKnownCondition(term);
      proposals.push({
        proposalId: nextId(),
        type: "condition",
        value: { text: kc ? `${kc.fi} (epäily)` : `${term} (epäily)`, bp: null, quantity: null, verificationStatus: "provisional" },
        source: src(s, suspect.index, suspect.index + suspect[0].length),
        certainty: clinician ? "suora" : "tulkinnanvarainen",
        issues: [
          "Diagnoosiepäily, ei varmistettu diagnoosi.",
          ...(clinician ? [] : ["Epäilyn esittäjä ei ole tunnistettu ammattilaiseksi."]),
          ...(kc ? [] : ["Koodia ei löytynyt tunnetusta luettelosta; tallennetaan tekstinä."]),
        ],
        subject: "potilas",
        negation: false,
        temporality: "nykyinen",
        codingCandidate: kc?.coding ?? null,
        targetResourceType: "Condition",
      });
      conditionMade = true;
    } else if (known && !family && /(sairast|todettu|diagnos|on\s+\p{L}*\s*$|minulla on|hänellä on)/iu.test(text)) {
      const neg = negatedBefore(text, text.toLowerCase().search(known.stems.find((st) => text.toLowerCase().includes(st))!));
      proposals.push({
        proposalId: nextId(),
        type: "condition",
        value: { text: neg ? `Ei ${known.fi.toLowerCase()}` : known.fi, bp: null, quantity: null, verificationStatus: neg ? null : "unconfirmed" },
        source: src(s),
        certainty: "tulkinnanvarainen",
        issues: ["Keskustelussa mainittu aiempi diagnoosi; varmista ennen tallennusta."],
        subject: "potilas",
        negation: neg,
        temporality: "aiempi/nykyinen",
        codingCandidate: known.coding,
        targetResourceType: neg ? null : "Condition",
      });
      note.history.push(`${speakerLabel(s.seg.speaker)} kertoo: ${text}`);
      consumed = true;
      conditionMade = true;
    }

    if (clinician && ASSESS_RE.test(text)) {
      if (!conditionMade) {
        proposals.push({
          proposalId: nextId(),
          type: "assessment",
          value: { text, bp: null, quantity: null, verificationStatus: null },
          source: src(s),
          certainty: "suora",
          issues: [],
          subject: "potilas",
          negation: false,
          temporality: "nykyinen",
          codingCandidate: null,
          targetResourceType: null,
        });
      }
      note.assessment.push(`Ammattilaisen arvio keskustelussa: ${text}`);
      consumed = true;
    } else if (conditionMade && !consumed) {
      note.assessment.push(`${speakerLabel(s.seg.speaker)}: ${text}`);
      consumed = true;
    }

    // --- Suunnitelma ---
    if (PLAN_RE.test(text) && (clinician || s.seg.speaker === "tuntematon")) {
      proposals.push({
        proposalId: nextId(),
        type: "plan",
        value: { text, bp: null, quantity: null, verificationStatus: null },
        source: src(s),
        certainty: clinician ? "suora" : "tulkinnanvarainen",
        issues: ["Suunnitelma kirjataan käyntimerkintään; tilauksia ei tehdä tässä versiossa."],
        subject: "potilas",
        negation: false,
        temporality: "tuleva",
        codingCandidate: null,
        targetResourceType: null,
      });
      note.plan.push(text);
      consumed = true;
    }

    // --- Lääkitys, allergiat, toimenpiteet ---
    if (ALLERGY_RE.test(text) || NO_ALLERGY_RE.test(text)) {
      const neg = NO_ALLERGY_RE.test(text);
      proposals.push({
        proposalId: nextId(),
        type: "allergy-mention",
        value: { text, bp: null, quantity: null, verificationStatus: null },
        source: src(s),
        certainty: "suora",
        issues: ["Allergialistaa ei päivitetä automaattisesti; tieto kirjataan käyntimerkintään."],
        subject,
        negation: neg,
        temporality: null,
        codingCandidate: null,
        targetResourceType: null,
      });
      note.history.push(`${speakerLabel(s.seg.speaker)} kertoo: ${text}`);
      consumed = true;
    } else if (MED_DOSE_RE.test(text) || (MED_RE.test(text) && !clinician)) {
      proposals.push({
        proposalId: nextId(),
        type: "medication-mention",
        value: { text, bp: null, quantity: null, verificationStatus: null },
        source: src(s),
        certainty: MED_DOSE_RE.test(text) ? "suora" : "tulkinnanvarainen",
        issues: ["Lääkitystä ei määrätä eikä lääkelistaa päivitetä tässä versiossa."],
        subject,
        negation: negatedBefore(text, text.length),
        temporality: /(käytän|käyttää|käytössä|otan|syön)/iu.test(text) ? "nykyinen" : null,
        codingCandidate: null,
        targetResourceType: null,
      });
      if (!consumed) note.history.push(`${speakerLabel(s.seg.speaker)} kertoo: ${text}`);
      consumed = true;
    }
    if (PROC_RE.test(text)) {
      const year = YEAR_RE.exec(text)?.[2];
      proposals.push({
        proposalId: nextId(),
        type: "procedure-history",
        value: { text, bp: null, quantity: null, verificationStatus: null },
        source: src(s),
        certainty: "suora",
        issues: [],
        subject,
        negation: false,
        temporality: year ? `vuonna ${year}` : "aiempi",
        codingCandidate: null,
        targetResourceType: null,
      });
      if (!consumed) note.history.push(`${speakerLabel(s.seg.speaker)} kertoo: ${text}`);
      consumed = true;
    }

    // --- Oireet ---
    if (!family && !hasVital) {
      for (const sym of SYMPTOMS) {
        const m = sym.re.exec(text);
        if (!m) continue;
        const neg = negatedBefore(text, m.index);
        const locText = sym.name === "kipu" ? findLocation(text) : null;
        const time = TIME_RE.exec(text);
        const symText = neg ? `Ei ${sym.partitive}` : `${sym.name[0].toUpperCase()}${sym.name.slice(1)}${locText ? `, sijainti: ${locText}` : ""}`;
        const p: ModelProposal = {
          proposalId: nextId(),
          type: "symptom",
          value: { text: symText, bp: null, quantity: null, verificationStatus: null },
          source: src(s),
          certainty: "suora",
          issues: neg ? ["Kielteinen löydös kirjataan käyntimerkintään; sitä ei tallenneta Condition-resurssina."] : [],
          subject: "potilas",
          negation: neg,
          temporality: time ? time[0].trim() : null,
          codingCandidate: null,
          targetResourceType: neg ? null : "Condition",
        };
        if (neg && sym.name === "kuume") negatedFever = p;
        proposals.push(p);
        if (!reasonFound && !neg && !clinician) {
          reasonFound = true;
          proposals.push({
            proposalId: nextId(),
            type: "reason",
            value: { text, bp: null, quantity: null, verificationStatus: null },
            source: src(s),
            certainty: "tulkinnanvarainen",
            issues: ["Käynnin syy on päätelty ensimmäisestä potilaan kertomasta oireesta."],
            subject: "potilas",
            negation: false,
            temporality: time ? time[0].trim() : null,
            codingCandidate: null,
            targetResourceType: null,
          });
          note.reason.push(text);
        }
      }
    }

    if (!consumed) {
      if (clinician && FINDING_RE.test(text)) note.findings.push(`Todettu: ${text}`);
      else if (!clinician) note.history.push(`${speakerLabel(s.seg.speaker)} kertoo: ${text}`);
      else if (FINDING_RE.test(text)) note.findings.push(`Todettu: ${text}`);
    }
  }

  // Ristiriidat: "ei kuumetta" ja kuumetasoinen lämpöarvo samassa keskustelussa.
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
  if (bps.length > 1) {
    for (const b of bps) b.issues.push(`Käynnillä ${bps.length} verenpainemittausta; tarkista, mitkä tallennetaan.`);
  }

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
