// Sovelluksen omat, tyypitetyt FHIR R4 -rakentajat hyväksytylle sisällölle.
// Mallin vastausta ei koskaan lähetetä sellaisenaan palvelimelle.

import { verifyCoding, VITAL_CODES } from "../clinical/codes";
import { NOTE_SECTION_LABELS, type NoteDraft, type Proposal } from "../clinical/schemas";
import { hashValue } from "../util/hash";
import { proposalContentHash } from "../workflow/review";
import { DEMO_TAG_CODE, DEMO_TAG_SYSTEM, SAVED_IDENTIFIER_SYSTEM, assertFhirId } from "./search-builders";
import { LOINC, UCUM, type Bundle, type BundleEntry, type Resource } from "./types";

export const OBS_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";
export const COND_CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical";
export const COND_VER = "http://terminology.hl7.org/CodeSystem/condition-ver-status";
export const COND_CATEGORY = "http://terminology.hl7.org/CodeSystem/condition-category";

export interface BuildContext {
  patientId: string;
  encounterId: string;
  transcriptVersion: string;
}

const demoMeta = () => ({ tag: [{ system: DEMO_TAG_SYSTEM, code: DEMO_TAG_CODE, display: "Synteettinen demoaineisto" }] });

export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function sourceNote(p: Proposal): string {
  const parts = [`Lähde: harjoituslitteraatti, puheenvuoro ${p.source.segmentId} (${p.source.speaker}): "${p.source.quote}"`];
  if (p.temporality) parts.push(`Ajallisuus: ${p.temporality}.`);
  return parts.join(" ");
}

function refs(ctx: BuildContext) {
  return {
    subject: { reference: `Patient/${assertFhirId(ctx.patientId)}` },
    encounter: { reference: `Encounter/${assertFhirId(ctx.encounterId)}` },
  };
}

export function buildObservation(p: Proposal, ctx: BuildContext, identifierValue: string): Resource {
  const { subject, encounter } = refs(ctx);
  const base = {
    resourceType: "Observation",
    meta: demoMeta(),
    identifier: [{ system: SAVED_IDENTIFIER_SYSTEM, value: identifierValue }],
    status: "preliminary",
    category: [{ coding: [{ system: OBS_CATEGORY, code: "vital-signs", display: "Vital Signs" }] }],
    subject,
    encounter,
    // effective[x] jätetään pois: mittausaikaa ei ilmaistu keskustelussa, eikä sitä keksitä.
    note: [{ text: `Mittausaika ei ilmennyt keskustelusta; mittaus tehty tämän kontaktin aikana. ${sourceNote(p)}` }],
  };
  if (p.type === "bp") {
    const bp = p.value.bp;
    if (!bp) throw new Error("Verenpainearvo puuttuu.");
    return {
      ...base,
      code: { coding: [{ ...VITAL_CODES.bpPanel }], text: "Verenpaine" },
      component: [
        {
          code: { coding: [{ ...VITAL_CODES.systolic }], text: "Systolinen verenpaine" },
          valueQuantity: { value: bp.systolic, unit: "mmHg", system: UCUM, code: "mm[Hg]" },
        },
        {
          code: { coding: [{ ...VITAL_CODES.diastolic }], text: "Diastolinen verenpaine" },
          valueQuantity: { value: bp.diastolic, unit: "mmHg", system: UCUM, code: "mm[Hg]" },
        },
      ],
    };
  }
  const q = p.value.quantity;
  if (!q) throw new Error("Mittausarvo puuttuu.");
  if (p.type === "heart-rate") {
    return {
      ...base,
      code: { coding: [{ ...VITAL_CODES.heartRate }], text: "Syke" },
      valueQuantity: { value: q.value, unit: "/min", system: UCUM, code: "/min" },
    };
  }
  if (p.type === "temperature") {
    return {
      ...base,
      code: { coding: [{ ...VITAL_CODES.temperature }], text: "Lämpö" },
      valueQuantity: { value: q.value, unit: "°C", system: UCUM, code: "Cel" },
    };
  }
  throw new Error(`Ehdotustyyppiä ${p.type} ei tallenneta Observation-resurssina.`);
}

export function buildCondition(p: Proposal, ctx: BuildContext, identifierValue: string): Resource {
  if (p.type !== "condition" && p.type !== "symptom") throw new Error(`Ehdotustyyppiä ${p.type} ei tallenneta Condition-resurssina.`);
  const { subject, encounter } = refs(ctx);
  const coding = verifyCoding(p.codingCandidate);
  const ver = p.type === "condition" ? (p.value.verificationStatus ?? "unconfirmed") : null;
  return {
    resourceType: "Condition",
    meta: demoMeta(),
    identifier: [{ system: SAVED_IDENTIFIER_SYSTEM, value: identifierValue }],
    clinicalStatus: { coding: [{ system: COND_CLINICAL, code: "active" }] },
    ...(ver ? { verificationStatus: { coding: [{ system: COND_VER, code: ver }] } } : {}),
    category: [{ coding: [{ system: COND_CATEGORY, code: "encounter-diagnosis", display: "Encounter Diagnosis" }] }],
    code: { ...(coding ? { coding: [{ ...coding }] } : {}), text: p.value.text },
    subject,
    encounter,
    note: [{ text: sourceNote(p) }],
  };
}

export function noteToText(note: NoteDraft, transcriptVersion: string): string {
  const sections = (Object.keys(NOTE_SECTION_LABELS) as (keyof NoteDraft)[])
    .filter((k) => note[k].trim())
    .map((k) => `${NOTE_SECTION_LABELS[k]}:\n${note[k].trim()}`);
  sections.push(
    `---\nLuonnos (docStatus=preliminary), ei allekirjoitettu. Synteettinen harjoitusaineisto. Litteraattiversio ${transcriptVersion}.`,
  );
  return sections.join("\n\n");
}

export function buildDocumentReference(note: NoteDraft, ctx: BuildContext, identifierValue: string, createdAt: string): Resource {
  const { subject, encounter } = refs(ctx);
  return {
    resourceType: "DocumentReference",
    meta: demoMeta(),
    identifier: [{ system: SAVED_IDENTIFIER_SYSTEM, value: identifierValue }],
    status: "current",
    docStatus: "preliminary",
    type: { coding: [{ system: LOINC, code: "11506-3", display: "Progress note" }], text: "Käyntimerkintä" },
    subject,
    date: createdAt,
    description: "Käyntimerkintäluonnos (demo, ei allekirjoitettu)",
    content: [
      {
        attachment: {
          contentType: "text/plain; charset=utf-8",
          language: "fi",
          title: "Käyntimerkintä",
          data: utf8ToBase64(noteToText(note, ctx.transcriptVersion)),
        },
      },
    ],
    context: { encounter: [encounter] },
  };
}

// ---------- Tallennus-Bundle ----------

export interface SaveInput extends BuildContext {
  note: NoteDraft | null;
  proposals: Proposal[];
  createdAt: string;
}

export interface SaveMapEntry {
  key: string; // "note" tai proposalId
  resourceType: string;
  fullUrl: string;
  identifierValue: string;
}

export function snapshotHash(input: SaveInput): string {
  return hashValue({
    patientId: input.patientId,
    encounterId: input.encounterId,
    transcriptVersion: input.transcriptVersion,
    note: input.note,
    proposals: input.proposals.map((p) => ({ id: p.proposalId, h: proposalContentHash(p) })),
    createdAt: input.createdAt,
  });
}

export function deterministicUuid(seed: string): string {
  const h = (hashValue(seed) + hashValue(seed + "#")).replace(/[^0-9a-f]/g, "").padEnd(32, "0").slice(0, 32);
  // Muodostetaan versio 4 -muotoinen UUID-merkkijono.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function buildSaveBundle(input: SaveInput): { bundle: Bundle; snapshot: string; map: SaveMapEntry[]; resources: Resource[] } {
  const snapshot = snapshotHash(input);
  const ctx: BuildContext = { patientId: input.patientId, encounterId: input.encounterId, transcriptVersion: input.transcriptVersion };
  const entries: BundleEntry[] = [];
  const map: SaveMapEntry[] = [];
  const resources: Resource[] = [];

  const add = (key: string, resource: Resource, identifierValue: string) => {
    const fullUrl = `urn:uuid:${deterministicUuid(`${snapshot}:${key}`)}`;
    entries.push({
      fullUrl,
      resource,
      request: {
        method: "POST",
        url: resource.resourceType,
        ifNoneExist: `identifier=${encodeURIComponent(SAVED_IDENTIFIER_SYSTEM)}|${encodeURIComponent(identifierValue)}`,
      },
    });
    map.push({ key, resourceType: resource.resourceType, fullUrl, identifierValue });
    resources.push(resource);
  };

  const idv = (key: string) => `${snapshot.slice(0, 24)}-${key}`;
  if (input.note) add("note", buildDocumentReference(input.note, ctx, idv("note"), input.createdAt), idv("note"));
  for (const p of input.proposals) {
    if (p.targetResourceType === "Observation") add(p.proposalId, buildObservation(p, ctx, idv(p.proposalId)), idv(p.proposalId));
    else if (p.targetResourceType === "Condition") add(p.proposalId, buildCondition(p, ctx, idv(p.proposalId)), idv(p.proposalId));
  }
  return { bundle: { resourceType: "Bundle", type: "transaction", entry: entries }, snapshot, map, resources };
}
