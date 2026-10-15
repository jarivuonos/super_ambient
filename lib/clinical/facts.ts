// Haettujen FHIR-resurssien muuntaminen lähteisiin sidotuiksi faktoiksi.
// Jokainen numeerinen arvo on jäljitettävissä resurssiin ja sen kenttään.

import { base64ToUtf8 } from "../fhir/resource-builders";
import { BP_DIASTOLIC, BP_PANEL_CODES, BP_SYSTOLIC } from "../fhir/search-builders";
import { LOINC, type CodeableConcept, type Observation, type Quantity, type Resource } from "../fhir/types";

export interface FactSource {
  resourceType: string;
  id: string;
  fields: string[];
}

export interface Fact {
  kind: string;
  label: string;
  text: string;
  /** Kliininen aika (mittaus-, tapahtuma- tai kirjausaika) – ei resurssin päivitysaika. */
  date: string | null;
  dateLabel: string;
  numbers: number[];
  flags: string[];
  source: FactSource;
  /** Ulkoista tekstisisältöä (näytetään vain tekstinä). */
  attachedText?: string;
}

const hasCode = (cc: CodeableConcept | undefined, codes: string[], system = LOINC) =>
  !!cc?.coding?.some((c) => c.system === system && c.code && codes.includes(c.code));

/**
 * Lääkkeen nimi: medicationCodeableConcept, muuten medicationReference.display, muuten sisältyvä
 * (contained) Medication-resurssi. Epic antaa lääkkeen viitteenä, joten pelkkä CodeableConcept ei riitä.
 */
export function medicationName(r: Resource): string {
  const direct = r.medicationCodeableConcept as CodeableConcept | undefined;
  if (direct) return conceptText(direct);
  const ref = r.medicationReference as { reference?: string; display?: string } | undefined;
  if (ref?.display?.trim()) return ref.display.trim();
  if (ref?.reference?.startsWith("#")) {
    const contained = (r.contained as Resource[] | undefined)?.find((c) => c.resourceType === "Medication" && c.id === ref.reference!.slice(1));
    const code = contained?.code as CodeableConcept | undefined;
    if (code) return conceptText(code);
  }
  return conceptText(undefined);
}

export function conceptText(cc: CodeableConcept | undefined): string {
  return cc?.text || cc?.coding?.find((c) => c.display)?.display || cc?.coding?.[0]?.code || "(nimeämätön)";
}

function effective(o: Observation): { date: string | null; field: string | null } {
  if (o.effectiveDateTime) return { date: o.effectiveDateTime, field: "effectiveDateTime" };
  if (o.effectivePeriod?.start) return { date: o.effectivePeriod.start, field: "effectivePeriod.start" };
  return { date: null, field: null };
}

export function formatNumber(n: number): string {
  return String(n).replace(".", ",");
}

export function formatDate(d: string | null): string {
  if (!d) return "aika ei tiedossa";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(d);
  if (!m) return d;
  const day = `${Number(m[3])}.${Number(m[2])}.${m[1]}`;
  return m[4] ? `${day} klo ${m[4]}.${m[5]}` : day;
}

function unitOf(q: Quantity | undefined): string {
  if (!q) return "";
  if (q.code === "mm[Hg]") return "mmHg";
  return q.unit ?? q.code ?? "";
}

/** Verenpaineet: paneelit komponentteineen sekä erilliset systoliset/diastoliset mittaukset erikseen. */
export function bloodPressureFacts(resources: Resource[]): Fact[] {
  const facts: Fact[] = [];
  for (const r of resources) {
    if (r.resourceType !== "Observation" || !r.id) continue;
    const o = r as Observation;
    const eff = effective(o);
    const dateFields = eff.field ? [eff.field] : [];
    if (hasCode(o.code, BP_PANEL_CODES)) {
      const ci = (code: string) => (o.component ?? []).findIndex((c) => hasCode(c.code, [code]));
      const si = ci(BP_SYSTOLIC);
      const di = ci(BP_DIASTOLIC);
      const sq = si >= 0 ? o.component![si].valueQuantity : undefined;
      const dq = di >= 0 ? o.component![di].valueQuantity : undefined;
      const flags: string[] = [];
      if (!eff.date) flags.push("Mittausaika puuttuu resurssista.");
      if (o.status && !["final", "amended", "corrected", "preliminary"].includes(o.status)) flags.push(`Tila: ${o.status}`);
      if (o.status === "preliminary") flags.push("Alustava (preliminary)");
      for (const [q, nm] of [
        [sq, "systolinen"],
        [dq, "diastolinen"],
      ] as const) {
        if (q && q.code && q.code !== "mm[Hg]") flags.push(`${nm}: odottamaton yksikkö ${q.code}`);
      }
      if (sq?.value === undefined || dq?.value === undefined) {
        flags.push("Paneelista puuttuu systolinen tai diastolinen arvo.");
      }
      const sTxt = sq?.value !== undefined ? formatNumber(sq.value) : "?";
      const dTxt = dq?.value !== undefined ? formatNumber(dq.value) : "?";
      facts.push({
        kind: "bp-panel",
        label: "Verenpaine",
        text: `${sTxt}/${dTxt} ${unitOf(sq ?? dq) || "mmHg"}`,
        date: eff.date,
        dateLabel: "mittausaika",
        numbers: [sq?.value, dq?.value].filter((n): n is number => typeof n === "number"),
        flags,
        source: {
          resourceType: "Observation",
          id: o.id!,
          fields: [
            ...(si >= 0 ? [`component[${si}].valueQuantity`] : []),
            ...(di >= 0 ? [`component[${di}].valueQuantity`] : []),
            ...dateFields,
          ],
        },
      });
    } else if (hasCode(o.code, [BP_SYSTOLIC, BP_DIASTOLIC]) && o.valueQuantity?.value !== undefined) {
      const isSys = hasCode(o.code, [BP_SYSTOLIC]);
      facts.push({
        kind: isSys ? "bp-systolic" : "bp-diastolic",
        label: isSys ? "Systolinen verenpaine (erillinen mittaus)" : "Diastolinen verenpaine (erillinen mittaus)",
        text: `${formatNumber(o.valueQuantity.value)} ${unitOf(o.valueQuantity)}`,
        date: eff.date,
        dateLabel: "mittausaika",
        numbers: [o.valueQuantity.value],
        flags: [
          "Erillinen mittausresurssi; sitä ei yhdistetä toiseen mittaukseen pariksi.",
          ...(eff.date ? [] : ["Mittausaika puuttuu resurssista."]),
        ],
        source: { resourceType: "Observation", id: o.id!, fields: ["valueQuantity", ...dateFields] },
      });
    }
  }
  return sortByDateDesc(facts);
}

export function sortByDateDesc(facts: Fact[]): Fact[] {
  return [...facts].sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return Date.parse(b.date) - Date.parse(a.date);
  });
}

function isAbnormal(o: Observation): string | null {
  const interp = o.interpretation?.flatMap((i) => i.coding ?? []).map((c) => c.code) ?? [];
  if (interp.some((c) => c && ["H", "HH", "L", "LL", "A", "AA"].includes(c))) return `Tulkinta: ${interp.join(", ")}`;
  const v = o.valueQuantity?.value;
  const rr = o.referenceRange?.[0];
  if (typeof v === "number" && rr) {
    if (rr.high?.value !== undefined && v > rr.high.value) return `Yli viitealueen (${formatNumber(rr.high.value)})`;
    if (rr.low?.value !== undefined && v < rr.low.value) return `Alle viitealueen (${formatNumber(rr.low.value)})`;
  }
  return null;
}

export function observationFacts(resources: Resource[], kind = "observation"): Fact[] {
  const facts: Fact[] = [];
  for (const r of resources) {
    if (r.resourceType !== "Observation" || !r.id) continue;
    const o = r as Observation;
    if (hasCode(o.code, [...BP_PANEL_CODES, BP_SYSTOLIC, BP_DIASTOLIC])) {
      facts.push(...bloodPressureFacts([o]));
      continue;
    }
    const eff = effective(o);
    const q = o.valueQuantity;
    const abnormal = isAbnormal(o);
    let text: string;
    let fields: string[];
    let numbers: number[] = [];
    if (q?.value !== undefined) {
      text = `${formatNumber(q.value)} ${unitOf(q)}`;
      fields = ["valueQuantity"];
      numbers = [q.value];
    } else if (o.valueString) {
      text = o.valueString;
      fields = ["valueString"];
    } else {
      text = "(ei arvoa)";
      fields = [];
    }
    facts.push({
      kind,
      label: conceptText(o.code),
      text,
      date: eff.date,
      dateLabel: "mittausaika",
      numbers,
      flags: [...(abnormal ? [abnormal] : []), ...(eff.date ? [] : ["Mittausaika puuttuu resurssista."])],
      source: { resourceType: "Observation", id: o.id!, fields: [...fields, ...(eff.field ? [eff.field] : [])] },
    });
  }
  return sortByDateDesc(facts);
}

const codeOf = (cc: unknown) => (cc as CodeableConcept | undefined)?.coding?.[0]?.code;

export function conditionFacts(resources: Resource[]): Fact[] {
  return sortByDateDesc(
    resources
      .filter((r) => r.resourceType === "Condition" && r.id)
      .map((c) => {
        const clin = codeOf(c.clinicalStatus);
        const ver = codeOf(c.verificationStatus);
        const date = (c.onsetDateTime as string) ?? (c.recordedDate as string) ?? null;
        return {
          kind: "condition",
          label: "Ongelma/diagnoosi",
          text: conceptText(c.code as CodeableConcept),
          date,
          dateLabel: c.onsetDateTime ? "alkanut" : "kirjattu",
          numbers: [],
          flags: [clin ? `kliininen tila: ${clin}` : "kliininen tila puuttuu", ...(ver ? [`varmuus: ${ver}`] : [])],
          source: { resourceType: "Condition", id: c.id!, fields: ["code", "clinicalStatus", "verificationStatus"] },
        };
      }),
  );
}

export function medicationFacts(resources: Resource[], now = new Date()): Fact[] {
  const out: Fact[] = [];
  for (const r of resources) {
    if (!r.id) continue;
    if (r.resourceType === "MedicationStatement") {
      const period = r.effectivePeriod as { start?: string } | undefined;
      const date = (r.effectiveDateTime as string) ?? period?.start ?? (r.dateAsserted as string) ?? null;
      out.push({
        kind: "medication-statement",
        label: "Lääkityskirjaus (MedicationStatement)",
        text: `${medicationName(r)} – ${((r.dosage as { text?: string }[]) ?? [])[0]?.text ?? "annostus ei tiedossa"}`,
        date,
        dateLabel: "voimassa alkaen",
        numbers: [],
        flags: [`tila: ${r.status ?? "ei tiedossa"}`, ...(r.dateAsserted ? [`viimeksi todettu ${formatDate(r.dateAsserted as string)}`] : [])],
        source: { resourceType: "MedicationStatement", id: r.id, fields: ["medicationCodeableConcept", "medicationReference", "status", "effectivePeriod"] },
      });
    } else if (r.resourceType === "MedicationRequest") {
      const authored = (r.authoredOn as string) ?? null;
      const old = authored ? now.getTime() - Date.parse(authored) > 365 * 24 * 3600 * 1000 : true;
      out.push({
        kind: "medication-request",
        label: "Lääkemääräys (MedicationRequest)",
        text: medicationName(r),
        date: authored,
        dateLabel: "määrätty",
        numbers: [],
        flags: [
          `tila: ${r.status ?? "ei tiedossa"}`,
          ...(old ? ["Määräys on yli vuoden vanha; se ei kerro nykyisestä lääkityksestä."] : []),
        ],
        source: { resourceType: "MedicationRequest", id: r.id, fields: ["medicationCodeableConcept", "medicationReference", "status", "authoredOn"] },
      });
    }
  }
  return sortByDateDesc(out);
}

export function allergyFacts(resources: Resource[]): Fact[] {
  return resources
    .filter((r) => r.resourceType === "AllergyIntolerance" && r.id)
    .map((a) => {
      const reactions = ((a.reaction as { manifestation?: CodeableConcept[] }[]) ?? [])
        .flatMap((x) => x.manifestation ?? [])
        .map(conceptText);
      return {
        kind: "allergy",
        label: "Allergia/intoleranssi",
        text: `${conceptText(a.code as CodeableConcept)}${reactions.length ? ` – reaktio: ${reactions.join(", ")}` : ""}`,
        date: (a.recordedDate as string) ?? null,
        dateLabel: "kirjattu",
        numbers: [],
        flags: [`tila: ${codeOf(a.clinicalStatus) ?? "ei tiedossa"}`, `varmuus: ${codeOf(a.verificationStatus) ?? "ei tiedossa"}`],
        source: { resourceType: "AllergyIntolerance", id: a.id!, fields: ["code", "reaction", "clinicalStatus"] },
      };
    });
}

/** Tekstiliite luetaan vain inline-datasta; ulkoisia URL-osoitteita ei haeta. */
function inlineText(att: { contentType?: string; data?: string; url?: string } | undefined): { text?: string; note?: string } {
  if (!att) return {};
  if (att.data && (!att.contentType || att.contentType.startsWith("text/"))) {
    try {
      return { text: base64ToUtf8(att.data).slice(0, 20000) };
    } catch {
      return { note: "Liitteen tekstiä ei voitu lukea." };
    }
  }
  if (att.url) return { note: "Liite on ulkoisessa osoitteessa; sitä ei haeta automaattisesti." };
  return { note: "Liitteen muotoa ei näytetä." };
}

export function reportFacts(resources: Resource[]): Fact[] {
  const out: Fact[] = [];
  for (const r of resources) {
    if (!r.id) continue;
    if (r.resourceType === "DiagnosticReport") {
      const form = inlineText((r.presentedForm as { contentType?: string; data?: string; url?: string }[] | undefined)?.[0]);
      const cats = ((r.category as CodeableConcept[]) ?? []).flatMap((c) => c.coding ?? []).map((c) => c.code);
      out.push({
        kind: "diagnostic-report",
        label: `Lausunto${cats.length ? ` (${cats.join(", ")})` : ""}`,
        text: `${conceptText(r.code as CodeableConcept)}${r.conclusion ? `: ${r.conclusion}` : ""}`,
        date: (r.effectiveDateTime as string) ?? (r.issued as string) ?? null,
        dateLabel: r.effectiveDateTime ? "tutkimusaika" : "julkaistu",
        numbers: [],
        flags: [`tila: ${r.status ?? "ei tiedossa"}`, ...(form.note ? [form.note] : [])],
        source: { resourceType: "DiagnosticReport", id: r.id, fields: ["code", "conclusion", ...(form.text ? ["presentedForm[0].data"] : [])] },
        attachedText: form.text,
      });
    } else if (r.resourceType === "DocumentReference") {
      const att = inlineText((r.content as { attachment?: { contentType?: string; data?: string; url?: string } }[] | undefined)?.[0]?.attachment);
      out.push({
        kind: "document",
        label: "Asiakirja (DocumentReference)",
        text: `${conceptText(r.type as CodeableConcept)}${r.description ? ` – ${r.description}` : ""}`,
        date: (r.date as string) ?? null,
        dateLabel: "laadittu",
        numbers: [],
        flags: [`tila: ${r.status ?? "?"}`, ...(r.docStatus ? [`docStatus: ${r.docStatus}`] : []), ...(att.note ? [att.note] : [])],
        source: { resourceType: "DocumentReference", id: r.id, fields: ["type", ...(att.text ? ["content[0].attachment.data"] : [])] },
        attachedText: att.text,
      });
    }
  }
  return sortByDateDesc(out);
}

const IMAGING_CATS = ["RAD", "LP29684-5", "imaging", "CT", "MR", "US", "XR"];
export function isImagingReport(f: Fact): boolean {
  return f.kind === "diagnostic-report" && (IMAGING_CATS.some((c) => f.label.includes(c)) || /röntgen|rtg|ct|mri|ultra|kuvant|xr/iu.test(f.text));
}

/** DocumentReference, jonka tyyppi viittaa kuvantamiseen (esim. Epicin "Diagnostic imaging study"). Sanarajat estävät osumat kuten "Doctor". */
const IMAGING_DOC = /\b(imaging|radiolog\w*|x-?ray|mri|ct|ultrasound|mammogra\w*)\b|röntgen|kuvant|ultraä|magneett/iu;
export function isImagingDocument(f: Fact): boolean {
  return f.kind === "document" && IMAGING_DOC.test(f.text);
}
