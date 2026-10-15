// Selaimen API-apurit. Kaikki FHIR- ja mallikutsut kulkevat sovelluksen palvelimen kautta.

import type { AskResponse } from "@/lib/clinical/ask";
import type { CapabilitySource } from "@/lib/clinical/language-adapter";
import type { NoteDraft, Proposal, Transcript } from "@/lib/clinical/schemas";
import type { SearchResult } from "@/lib/fhir/ehr-adapter";
import type { SaveMapEntry } from "@/lib/fhir/resource-builders";
import type { Bundle, Encounter, OperationOutcomeIssue, Patient, Resource } from "@/lib/fhir/types";
import type { SaveOutcome } from "@/lib/workflow/save";

export interface ApiError {
  message: string;
  status?: number;
  detail?: unknown;
  network?: boolean;
  aborted?: boolean;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      method: init?.method ?? (init?.json !== undefined || init?.body ? "POST" : "GET"),
      headers: init?.json !== undefined ? { "Content-Type": "application/json" } : init?.headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    });
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    return { ok: false, error: { message: aborted ? "Pyyntö peruttiin." : "Yhteys sovelluksen palvelimeen epäonnistui.", network: !aborted, aborted } };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* tyhjä tai ei-JSON */
  }
  if (!res.ok) {
    const err = (body as { error?: { message?: string; detail?: unknown } } | null)?.error;
    return { ok: false, error: { message: err?.message ?? `Palvelinvirhe (HTTP ${res.status}).`, status: res.status, detail: err?.detail ?? body } };
  }
  return { ok: true, data: body as T };
}

export interface StatusResponse {
  auth: { required: false } | { required: true; configured: boolean; loggedIn: boolean; expiresAt: string | null };
  fhir: {
    adapter: string;
    baseUrl: string;
    check:
      | { ok: true; checkedAt: string; summary: { fhirVersion?: string; software?: string; transaction: boolean; resources: Record<string, { conditionalCreate: boolean; create: boolean }> } }
      | { ok: false; checkedAt: string; error: { kind: string; message: string; status?: number } };
    lastSuccessAt: string | null;
  };
  language: {
    name: string;
    kind: "mock" | "model" | "hybrid" | "unavailable";
    description: string;
    model: string | null;
    capabilities: { interpretQuestion: CapabilitySource; answer: CapabilitySource; structureTranscript: CapabilitySource };
  };
  transcription: { name: string; configured: boolean; description: string; capabilities: Record<string, boolean> };
}

export type PatientSearch = SearchResult<Patient>;
export type EncounterSearch = SearchResult<Encounter>;
export type AskResult = AskResponse & { patientId: string; encounterId: string | null };

export interface StructureResponse {
  source: string;
  sourceKind: "mock" | "model" | "pasted" | "unavailable" | "deterministic" | "classified";
  /** Rakenteistuksen tekniset tiedot (vain Jev-luokittelussa). */
  diagnostics?: unknown;
  transcriptVersion: string;
  note: NoteDraft;
  proposals: Proposal[];
  warnings: string[];
}

export interface SaveRequestBody {
  patientId: string;
  encounterId: string;
  transcript: Transcript;
  note: { draft: NoteDraft; approvedHash: string | null } | null;
  proposals: Proposal[];
  createdAt: string;
  expectedSnapshot?: string;
  sourceId: string;
}

export interface PreviewResponse {
  ok: boolean;
  errors: string[];
  snapshot?: string;
  bundle?: Bundle;
  map?: SaveMapEntry[];
  validation?: { key: string; result: { ok: boolean; issues: OperationOutcomeIssue[]; unavailable?: string } }[];
}

export type { SaveOutcome };

export interface SeedPreview {
  items: { key: string; summary: string; resourceType: string }[];
  bundle: Bundle;
}
export interface SeedResult {
  ok: boolean;
  entries?: { key: string; summary: string; resourceType: string; reference?: string; status: string; existing: boolean }[];
  error?: string;
}

export interface ReadResult {
  results: { reference: string; ok: boolean; error?: string; resource?: Resource }[];
}

export function patientName(p: Patient | undefined | null): string {
  if (!p) return "";
  const n = p.name?.[0];
  return n?.text || [n?.given?.join(" "), n?.family].filter(Boolean).join(" ") || "(nimetön)";
}

export function encounterLabel(e: Encounter): string {
  const type = e.type?.[0]?.text ?? e.type?.[0]?.coding?.[0]?.display ?? e.class?.display ?? "Kontakti";
  const start = e.period?.start ? new Date(e.period.start).toLocaleDateString("fi-FI") : "aika ei tiedossa";
  return `${type} – ${start} (${e.status ?? "?"})`;
}
