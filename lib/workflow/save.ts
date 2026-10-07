// Palvelinpuolen tallennuspolku: uudelleentarkistus → validointi → transaction → takaisinluku.
// Hakusuunnittelija tai kielimalli ei voi kutsua tätä; se käynnistyy vain käyttäjän tallennuspyynnöstä.

import { z } from "zod";
import { NoteDraftSchema, ProposalSchema, TranscriptSchema } from "../clinical/schemas";
import { transcriptVersion, verifySourceRef } from "../clinical/transcript";
import type { CapabilitySummary, EhrAdapter, ValidationResult } from "../fhir/ehr-adapter";
import { describeIssues } from "../fhir/http";
import { normalizeReference } from "../fhir/patient-guard";
import { buildSaveBundle, type SaveMapEntry } from "../fhir/resource-builders";
import { DEMO_TAG_CODE, DEMO_TAG_SYSTEM, SAVED_IDENTIFIER_SYSTEM } from "../fhir/search-builders";
import type { Bundle, Resource } from "../fhir/types";
import { allowedTarget, isApprovalValid, isNoteApproved } from "./review";

export const SaveRequestSchema = z.strictObject({
  patientId: z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/),
  encounterId: z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/),
  transcript: TranscriptSchema,
  note: z.strictObject({ draft: NoteDraftSchema, approvedHash: z.string().nullable() }).nullable(),
  proposals: z.array(ProposalSchema).max(100),
  createdAt: z.iso.datetime({ offset: true }),
  expectedSnapshot: z.string().optional(),
});
export type SaveRequest = z.infer<typeof SaveRequestSchema>;

export interface PreparedSave {
  ok: boolean;
  errors: string[];
  bundle?: Bundle;
  snapshot?: string;
  map?: SaveMapEntry[];
  resources?: Resource[];
}

/** Puhdas uudelleentarkistus: hyväksynnät, lähdeversio, kohteet ja resurssirakenteet. */
export function prepareSave(req: SaveRequest): PreparedSave {
  const errors: string[] = [];
  const t = req.transcript;
  if (transcriptVersion(t.segments) !== t.version) errors.push("Litteraattiversio ei vastaa litteraatin sisältöä.");
  const note = req.note && isNoteApproved(req.note) ? req.note.draft : null;
  if (req.note && !note) errors.push("Käyntimerkintää on muutettu hyväksynnän jälkeen tai sitä ei ole hyväksytty.");
  for (const p of req.proposals) {
    if (!isApprovalValid(p)) errors.push(`Ehdotus ${p.proposalId}: hyväksyntä puuttuu tai on vanhentunut.`);
    const refErr = verifySourceRef(t, p.source);
    if (refErr) errors.push(`Ehdotus ${p.proposalId}: ${refErr}`);
    const rule = allowedTarget(p);
    if (!p.targetResourceType || rule.target !== p.targetResourceType) {
      errors.push(`Ehdotus ${p.proposalId}: ei tallennettavissa (${rule.reason ?? "FHIR-kohde ei ole sallittu"}).`);
    }
  }
  if (!note && req.proposals.length === 0) errors.push("Ei hyväksyttyä tallennettavaa sisältöä.");
  if (errors.length) return { ok: false, errors };
  try {
    const built = buildSaveBundle({
      patientId: req.patientId,
      encounterId: req.encounterId,
      transcriptVersion: t.version,
      note,
      proposals: req.proposals,
      createdAt: req.createdAt,
    });
    return { ok: true, errors: [], ...built };
  } catch (e) {
    return { ok: false, errors: [`Resurssin muodostus epäonnistui: ${(e as Error).message}`] };
  }
}

/** Tarkistaa palvelimelta potilaan (demoaineistoa), kontaktin kuulumisen potilaalle ja kirjoituskyvykkyydet. */
export async function checkServerContext(
  ehr: EhrAdapter,
  req: Pick<SaveRequest, "patientId" | "encounterId">,
  resourceTypes: string[],
  caps: CapabilitySummary | null,
  signal?: AbortSignal,
): Promise<string[]> {
  const errors: string[] = [];
  if (!caps) errors.push("Palvelimen kyvykkyyksiä ei voitu tarkistaa; tallennus estetty.");
  else {
    if (!caps.transaction) errors.push("Palvelin ei tue transaction-pyyntöä; erillisiä POST-pyyntöjä ei esitetä atomisena tallennuksena.");
    for (const rt of new Set(resourceTypes)) {
      const c = caps.resources[rt];
      if (!c?.create || !c.conditionalCreate) errors.push(`Palvelin ei tue ${rt}-resurssin conditional createa.`);
    }
  }
  const [pat, enc] = await Promise.all([
    ehr.read("Patient", req.patientId, signal),
    ehr.read("Encounter", req.encounterId, signal),
  ]);
  if (!pat.ok) errors.push(`Potilasta ei voitu lukea: ${pat.error.message}`);
  else if (!pat.resource.meta?.tag?.some((t) => t.system === DEMO_TAG_SYSTEM && t.code === DEMO_TAG_CODE)) {
    errors.push("Tallennus sallitaan vain sovelluksen omalle synteettiselle demopotilaalle (demotunniste puuttuu).");
  }
  if (!enc.ok) errors.push(`Kontaktia ei voitu lukea: ${enc.error.message}`);
  else {
    const subj = normalizeReference((enc.resource.subject as { reference?: string } | undefined)?.reference, ehr.baseUrl);
    if (subj !== `Patient/${req.patientId}`) errors.push("Valittu kontakti ei kuulu valitulle potilaalle.");
  }
  return errors;
}

export interface ReadbackDetail {
  key: string;
  reference?: string;
  ok: boolean;
  problems: string[];
}

export interface SaveOutcome {
  stage: "blocked" | "rejected" | "unknown" | "accepted";
  message: string;
  snapshot?: string;
  errors: string[];
  validation?: { key: string; result: ValidationResult }[];
  entries: { key: string; resourceType: string; reference?: string; status?: string; existing?: boolean; identifier: string }[];
  readback: { state: "verified" | "mismatch" | "failed" | "not-run"; details: ReadbackDetail[] };
  recoveredByIdentifier?: boolean;
}

const pick = (r: Resource, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[/^\d+$/.test(k) ? Number(k) : k] : undefined), r);

/** Vertaa takaisinluettua resurssia lähetettyyn: potilas-, kontakti- ja sisältöviitteet. */
export function compareReadback(sent: Resource, got: Resource, baseUrl: string): string[] {
  const problems: string[] = [];
  const norm = (v: unknown) => normalizeReference((v as { reference?: string } | undefined)?.reference, baseUrl);
  if (got.resourceType !== sent.resourceType) problems.push("Resurssityyppi poikkeaa.");
  if (norm(got.subject) !== norm(sent.subject)) problems.push("Potilasviite poikkeaa.");
  const encPath = sent.resourceType === "DocumentReference" ? "context.encounter.0" : "encounter";
  if (norm(pick(got, encPath)) !== norm(pick(sent, encPath))) problems.push("Kontaktiviite poikkeaa.");
  const sentId = sent.identifier?.find((i) => i.system === SAVED_IDENTIFIER_SYSTEM)?.value;
  if (!got.identifier?.some((i) => i.system === SAVED_IDENTIFIER_SYSTEM && i.value === sentId)) problems.push("Tunniste poikkeaa.");
  const contentPaths: Record<string, string[]> = {
    Observation: ["code.coding.0.code", "valueQuantity.value", "valueQuantity.code", "component.0.valueQuantity.value", "component.1.valueQuantity.value"],
    Condition: ["code.text", "code.coding.0.code", "verificationStatus.coding.0.code", "clinicalStatus.coding.0.code"],
    DocumentReference: ["content.0.attachment.data", "docStatus", "status"],
  };
  for (const p of contentPaths[sent.resourceType] ?? []) {
    if (JSON.stringify(pick(sent, p)) !== JSON.stringify(pick(got, p))) problems.push(`Sisältö poikkeaa kentässä ${p}.`);
  }
  return problems;
}

export async function executeSave(
  ehr: EhrAdapter,
  req: SaveRequest,
  caps: CapabilitySummary | null,
  opts: { validate: boolean; signal?: AbortSignal },
): Promise<SaveOutcome> {
  const empty = { entries: [], readback: { state: "not-run" as const, details: [] } };
  const prepared = prepareSave(req);
  if (!prepared.ok) return { stage: "blocked", message: "Tallennus estettiin tarkistuksessa.", errors: prepared.errors, ...empty };
  const { bundle, snapshot, map, resources } = prepared as Required<PreparedSave>;
  if (req.expectedSnapshot && req.expectedSnapshot !== snapshot) {
    return { stage: "blocked", message: "Tarkistettu tilannevedos on muuttunut. Esikatsele uudelleen.", errors: ["Tilannevedos ei täsmää."], snapshot, ...empty };
  }
  const ctxErrors = await checkServerContext(ehr, req, resources.map((r) => r.resourceType), caps, opts.signal);
  if (ctxErrors.length) return { stage: "blocked", message: "Tallennus estettiin palvelintarkistuksessa.", errors: ctxErrors, snapshot, ...empty };

  let validation: SaveOutcome["validation"];
  if (opts.validate) {
    validation = [];
    for (let i = 0; i < resources.length; i++) {
      validation.push({ key: map[i].key, result: await ehr.validate(resources[i], opts.signal) });
    }
    const failed = validation.filter((v) => !v.result.ok && !v.result.unavailable);
    if (failed.length) {
      return {
        stage: "blocked",
        message: "Palvelimen validointi löysi virheitä.",
        errors: failed.map((f) => `${f.key}: ${describeIssues(f.result.issues.filter((i) => i.severity === "error" || i.severity === "fatal"))}`),
        validation,
        snapshot,
        ...empty,
      };
    }
  }

  const tx = await ehr.transaction(bundle, opts.signal);
  let refs: { key: string; reference?: string; status?: string; existing?: boolean }[] = [];
  let recovered = false;
  if (tx.state === "rejected") {
    return {
      stage: "rejected",
      message: "Palvelin hylkäsi tallennuksen. Mitään ei tallennettu (transaction).",
      errors: [tx.error.message],
      validation,
      snapshot,
      entries: map.map((m, i) => ({ key: m.key, resourceType: m.resourceType, identifier: m.identifierValue, status: tx.entries?.[i]?.status })),
      readback: { state: "not-run", details: [] },
    };
  }
  if (tx.state === "unknown") {
    // Lopputulos tuntematon: tarkistetaan tunnisteiden avulla ennen mahdollista uusintaa.
    const found = await Promise.all(map.map((m) => ehr.findByIdentifier(m.resourceType, SAVED_IDENTIFIER_SYSTEM, m.identifierValue, opts.signal)));
    if (found.some((f) => f.state === "error")) {
      return {
        stage: "unknown",
        message: "Tallennuksen tila on tuntematon, eikä tarkistushakua voitu tehdä. Älä tallenna uudelleen ennen tarkistusta.",
        errors: [tx.error.message],
        validation,
        snapshot,
        entries: map.map((m) => ({ key: m.key, resourceType: m.resourceType, identifier: m.identifierValue })),
        readback: { state: "not-run", details: [] },
      };
    }
    const hits = found.map((f) => f.resources[0]);
    if (hits.every((h) => !h)) {
      return {
        stage: "unknown",
        message: "Tallennus ei mennyt perille (tunnisteilla ei löytynyt resursseja). Voit yrittää uudelleen; sama tunniste estää duplikaatit.",
        errors: [tx.error.message],
        validation,
        snapshot,
        entries: map.map((m) => ({ key: m.key, resourceType: m.resourceType, identifier: m.identifierValue })),
        readback: { state: "not-run", details: [] },
      };
    }
    if (hits.some((h) => !h)) {
      return {
        stage: "unknown",
        message: "Osa resursseista löytyi tunnisteella, osa ei. Tilanne vaatii tarkistuksen.",
        errors: [tx.error.message],
        validation,
        snapshot,
        entries: map.map((m, i) => ({ key: m.key, resourceType: m.resourceType, identifier: m.identifierValue, reference: hits[i] ? `${hits[i]!.resourceType}/${hits[i]!.id}` : undefined })),
        readback: { state: "not-run", details: [] },
      };
    }
    recovered = true;
    refs = map.map((m, i) => ({ key: m.key, reference: `${hits[i]!.resourceType}/${hits[i]!.id}`, status: "löytyi tunnisteella" }));
  } else {
    refs = map.map((m, i) => ({ key: m.key, reference: tx.entries[i].reference, status: tx.entries[i].status, existing: tx.entries[i].existing }));
  }

  // Takaisinluku: erillinen vaihe. Sen epäonnistuminen ei tarkoita, että tallennus epäonnistui.
  const details: ReadbackDetail[] = [];
  for (let i = 0; i < map.length; i++) {
    const ref = refs[i].reference;
    if (!ref) {
      details.push({ key: map[i].key, ok: false, problems: ["Viite puuttuu."] });
      continue;
    }
    const [rt, id] = ref.split("/");
    const got = await ehr.read(rt, id, opts.signal);
    if (!got.ok) details.push({ key: map[i].key, reference: ref, ok: false, problems: [`Luku epäonnistui: ${got.error.message}`] });
    else {
      const problems = compareReadback(resources[i], got.resource, ehr.baseUrl);
      details.push({ key: map[i].key, reference: ref, ok: problems.length === 0, problems });
    }
  }
  const readFailed = details.some((d) => d.problems.some((p) => p.startsWith("Luku epäonnistui") || p === "Viite puuttuu."));
  const state = details.every((d) => d.ok) ? "verified" : readFailed ? "failed" : "mismatch";
  return {
    stage: "accepted",
    message: recovered
      ? "Tallennus löytyi palvelimelta tunnisteiden avulla aikakatkaisun jälkeen."
      : refs.every((r) => r.existing)
        ? "Palvelin hyväksyi pyynnön; kaikki resurssit olivat jo olemassa samalla tunnisteella (ei duplikaatteja)."
        : "Tallennus hyväksytty palvelimella.",
    errors: [],
    validation,
    snapshot,
    entries: map.map((m, i) => ({ resourceType: m.resourceType, identifier: m.identifierValue, ...refs[i] })),
    readback: { state, details },
    recoveredByIdentifier: recovered,
  };
}
