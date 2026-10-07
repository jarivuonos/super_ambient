// Ehdotusten tarkistus, hyväksyntä ja hyväksynnän vanheneminen.
// Puhtaita funktioita: käytetään sekä selaimessa että palvelimen uudelleentarkistuksessa.

import { verifyCoding } from "../clinical/codes";
import {
  StructuringOutputSchema,
  type ModelProposal,
  type NoteDraft,
  type Proposal,
  type Transcript,
} from "../clinical/schemas";
import { verifySourceRef } from "../clinical/transcript";
import { hashValue } from "../util/hash";

export interface WorkContext {
  patientId: string;
  encounterId: string;
  transcriptVersion: string;
}

export function sameContext(a: WorkContext | null | undefined, b: WorkContext | null | undefined): boolean {
  return !!a && !!b && a.patientId === b.patientId && a.encounterId === b.encounterId && a.transcriptVersion === b.transcriptVersion;
}

export function proposalContentHash(p: Proposal | ModelProposal): string {
  return hashValue({
    id: p.proposalId,
    type: p.type,
    value: p.value,
    source: p.source,
    subject: p.subject,
    negation: p.negation,
    temporality: p.temporality,
    codingCandidate: p.codingCandidate,
    targetResourceType: p.targetResourceType,
  });
}

export function approveProposal(p: Proposal): Proposal {
  return { ...p, reviewStatus: "hyväksytty", approvedHash: proposalContentHash(p) };
}

export function rejectProposal(p: Proposal): Proposal {
  return { ...p, reviewStatus: "hylätty", approvedHash: null };
}

/** Muokkaus: jos sisältö muuttuu, hyväksyntä peruuntuu. */
export function editProposal(p: Proposal, patch: Partial<Pick<Proposal, "value" | "temporality" | "negation" | "targetResourceType">>): Proposal {
  const merged: Proposal = { ...p, ...patch, value: { ...p.value, ...(patch.value ?? {}) } };
  // Kohde lasketaan uudelleen säännöistä, jotta näkymä vastaa palvelimen tarkistusta.
  const rule = allowedTarget(merged);
  // Mittaukset seuraavat arvon kelpoisuutta; muut säilyttävät aiemman poissulun.
  const keepExcluded = p.targetResourceType === null && patch.targetResourceType === undefined && !isVitalType(p.type);
  const next: Proposal = { ...merged, targetResourceType: keepExcluded ? null : rule.target };
  if (proposalContentHash(next) !== proposalContentHash(p)) {
    return { ...next, reviewStatus: "tarkistamatta", approvedHash: null };
  }
  return next;
}

export function isApprovalValid(p: Proposal): boolean {
  return p.reviewStatus === "hyväksytty" && p.approvedHash === proposalContentHash(p);
}

export interface NoteState {
  draft: NoteDraft;
  approvedHash: string | null;
}

export function noteHash(d: NoteDraft): string {
  return hashValue(d);
}
export function approveNote(n: NoteState): NoteState {
  return { ...n, approvedHash: noteHash(n.draft) };
}
export function editNote(n: NoteState, patch: Partial<NoteDraft>): NoteState {
  const draft = { ...n.draft, ...patch };
  return { draft, approvedHash: noteHash(draft) === n.approvedHash ? n.approvedHash : null };
}
export function isNoteApproved(n: NoteState): boolean {
  return n.approvedHash !== null && n.approvedHash === noteHash(n.draft);
}

/** Tallennettavaksi kelpaava ehdotus: hyväksytty, voimassa ja FHIR-kohde tiedossa. */
export function isSavable(p: Proposal): boolean {
  return isApprovalValid(p) && p.targetResourceType !== null;
}

const isVitalType = (t: Proposal["type"]) => t === "bp" || t === "heart-rate" || t === "temperature";

/** Sovelluksen säännöt sille, mihin FHIR-resurssiin ehdotus saa ylipäätään päätyä. */
export function allowedTarget(p: Pick<Proposal, "type" | "value" | "subject" | "negation">): {
  target: "Observation" | "Condition" | null;
  reason?: string;
} {
  let target: "Observation" | "Condition" | null = null;
  if (p.type === "bp" || p.type === "heart-rate" || p.type === "temperature") {
    const validBp = p.type !== "bp" || (!!p.value.bp && p.value.bp.systolic > p.value.bp.diastolic && p.value.bp.diastolic > 0);
    const validQty = p.type === "bp" || (!!p.value.quantity && Number.isFinite(p.value.quantity.value));
    if (!validBp || !validQty) return { target: null, reason: "Mittausarvo puuttuu tai on virheellinen; ei tallenneta havaintona." };
    target = "Observation";
  } else if (p.type === "condition" || p.type === "symptom") {
    target = "Condition";
  } else {
    return { target: null };
  }
  if (p.subject !== "potilas") return { target: null, reason: "Tieto ei koske potilasta; sitä ei tallenneta potilaan resurssina." };
  if (p.negation) return { target: null, reason: "Kielteistä löydöstä ei tallenneta Condition-/Observation-resurssina." };
  return { target };
}

export interface FinalizeResult {
  ok: boolean;
  note?: NoteDraft;
  proposals: Proposal[];
  warnings: string[];
  error?: string;
}

/**
 * Validoi mallin (tai mock-rakenteistajan, tai käsin liitetyn) vastauksen ja pakottaa
 * sovelluksen säännöt: lähdeviitteet tarkistetaan, tuntemattomat koodit poistetaan,
 * FHIR-kohde rajataan ja kaikki ehdotukset alkavat tarkistamattomina.
 */
export function finalizeStructuring(raw: unknown, transcript: Transcript): FinalizeResult {
  const parsed = StructuringOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      proposals: [],
      warnings: [],
      error: `Vastaus ei vastannut skeemaa: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  const proposals: Proposal[] = [];
  for (const mp of parsed.data.proposals) {
    if (seen.has(mp.proposalId)) {
      warnings.push(`Ehdotus ${mp.proposalId} toistui; jälkimmäinen ohitettiin.`);
      continue;
    }
    seen.add(mp.proposalId);
    const refErr = verifySourceRef(transcript, mp.source);
    if (refErr) {
      warnings.push(`Ehdotus ${mp.proposalId} hylättiin: ${refErr}`);
      continue;
    }
    const appIssues: string[] = [];
    const seg = transcript.segments.find((s) => s.id === mp.source.segmentId)!;
    const p: Proposal = {
      ...mp,
      source: { ...mp.source, speaker: seg.speaker },
      issues: [...mp.issues],
      reviewStatus: "tarkistamatta",
      approvedHash: null,
      appIssues,
    };

    if (p.codingCandidate) {
      const verified = verifyCoding(p.codingCandidate);
      if (!verified) {
        appIssues.push("Koodiehdotusta ei löytynyt tunnetusta koodistosta; koodi poistettiin.");
        p.codingCandidate = null;
      } else {
        p.codingCandidate = { ...verified };
      }
    }

    const rule = allowedTarget(p);
    if (rule.reason && p.targetResourceType) appIssues.push(rule.reason);
    // Malli voi jättää kohteen pois, mutta ei laajentaa sitä.
    p.targetResourceType = p.targetResourceType === null && p.type !== "bp" && p.type !== "heart-rate" && p.type !== "temperature" ? null : rule.target;

    if (p.type === "condition") {
      if (p.value.verificationStatus === "confirmed") {
        appIssues.push("Ehdotus ei voi itse asettaa varmistettua diagnoosia; muutettu varmistamattomaksi.");
        p.value = { ...p.value, verificationStatus: "unconfirmed" };
      }
      if (!p.value.verificationStatus) p.value = { ...p.value, verificationStatus: "unconfirmed" };
    }
    proposals.push(p);
  }
  return { ok: true, note: parsed.data.note, proposals, warnings };
}
