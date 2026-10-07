// Ennalta sallitut hakurakentajat. Kielimalli ei koskaan tuota URL:ää:
// se palauttaa tiedontarpeen, ja nämä funktiot muodostavat lukuhaut valitulle potilaalle.

import { LOINC } from "./types";

export const DEMO_TAG_SYSTEM = "urn:super-ambient:demo";
export const DEMO_TAG_CODE = "synthetic-demo";
export const DEMO_IDENTIFIER_SYSTEM = "urn:super-ambient:demo:identifier";
export const SAVED_IDENTIFIER_SYSTEM = "urn:super-ambient:demo:saved";

export const PAGE_SIZE = 20;

export const BP_PANEL_CODES = ["85354-9", "55284-4"];
export const BP_SYSTOLIC = "8480-6";
export const BP_DIASTOLIC = "8462-4";

export type ReadableResourceType =
  | "Observation"
  | "Condition"
  | "MedicationRequest"
  | "MedicationStatement"
  | "AllergyIntolerance"
  | "DiagnosticReport"
  | "DocumentReference";

export const READABLE_RESOURCE_TYPES: ReadableResourceType[] = [
  "Observation",
  "Condition",
  "MedicationRequest",
  "MedicationStatement",
  "AllergyIntolerance",
  "DiagnosticReport",
  "DocumentReference",
];

/** Resurssit, joilla on `encounter`-hakuehto HAPI:n CapabilityStatementin mukaan. */
const ENCOUNTER_SEARCHABLE = new Set<ReadableResourceType>([
  "Observation",
  "Condition",
  "MedicationRequest",
  "DiagnosticReport",
  "DocumentReference",
]);

/** Resurssit, joilla on `date`-hakuehto ja `_sort=-date` on mielekäs. */
const DATE_SORTABLE = new Set<ReadableResourceType>([
  "Observation",
  "MedicationRequest",
  "AllergyIntolerance",
  "DiagnosticReport",
  "DocumentReference",
]);

export interface SearchSpec {
  resourceType: ReadableResourceType | "Patient" | "Encounter";
  params: [string, string][];
  /** Käyttäjälle näytettävä kuvaus haun tarkoituksesta. */
  purpose: string;
}

export function toQueryPath(spec: SearchSpec): string {
  const qs = new URLSearchParams(spec.params);
  return `${spec.resourceType}?${qs.toString()}`;
}

const SAFE_ID = /^[A-Za-z0-9\-.]{1,64}$/;

export function assertFhirId(id: string, what = "tunniste"): string {
  if (!SAFE_ID.test(id)) throw new Error(`Virheellinen ${what}: ${JSON.stringify(id)}`);
  return id;
}

export interface Scope {
  patientId: string;
  encounterId?: string;
  /** Rajataanko haku valittuun kontaktiin. Oletuksena ei (pitkittäiskysely). */
  encounterOnly?: boolean;
  /** Päivämäärä (YYYY-MM-DD), jota vanhempia ei haeta. */
  since?: string;
}

function baseParams(rt: ReadableResourceType, scope: Scope): [string, string][] {
  const p: [string, string][] = [["patient", assertFhirId(scope.patientId, "Patient-tunniste")]];
  if (scope.encounterOnly && scope.encounterId && ENCOUNTER_SEARCHABLE.has(rt)) {
    p.push(["encounter", assertFhirId(scope.encounterId, "Encounter-tunniste")]);
  }
  if (scope.since && DATE_SORTABLE.has(rt) && /^\d{4}-\d{2}-\d{2}$/.test(scope.since)) {
    p.push(["date", `ge${scope.since}`]);
  }
  return p;
}

function sortCount(rt: ReadableResourceType): [string, string][] {
  const p: [string, string][] = [];
  if (DATE_SORTABLE.has(rt)) p.push(["_sort", "-date"]);
  p.push(["_count", String(PAGE_SIZE)]);
  return p;
}

export const builders = {
  bloodPressure(scope: Scope): SearchSpec {
    const codes = [...BP_PANEL_CODES, BP_SYSTOLIC, BP_DIASTOLIC].map((c) => `${LOINC}|${c}`).join(",");
    return {
      resourceType: "Observation",
      params: [...baseParams("Observation", scope), ["code", codes], ...sortCount("Observation")],
      purpose: "Verenpainemittaukset (LOINC 85354-9, 8480-6, 8462-4)",
    };
  },
  vitalSigns(scope: Scope): SearchSpec {
    return {
      resourceType: "Observation",
      params: [...baseParams("Observation", scope), ["category", "vital-signs"], ...sortCount("Observation")],
      purpose: "Vitaalimittaukset",
    };
  },
  laboratory(scope: Scope): SearchSpec {
    return {
      resourceType: "Observation",
      params: [...baseParams("Observation", scope), ["category", "laboratory"], ...sortCount("Observation")],
      purpose: "Laboratoriotulokset",
    };
  },
  observations(scope: Scope): SearchSpec {
    return {
      resourceType: "Observation",
      params: [...baseParams("Observation", scope), ...sortCount("Observation")],
      purpose: "Havainnot",
    };
  },
  conditions(scope: Scope): SearchSpec {
    return {
      resourceType: "Condition",
      params: [...baseParams("Condition", scope), ...sortCount("Condition")],
      purpose: "Ongelmat ja diagnoosit",
    };
  },
  medicationStatements(scope: Scope): SearchSpec {
    return {
      resourceType: "MedicationStatement",
      params: [...baseParams("MedicationStatement", scope), ...sortCount("MedicationStatement")],
      purpose: "Lääkityskirjaukset (MedicationStatement)",
    };
  },
  medicationRequests(scope: Scope): SearchSpec {
    return {
      resourceType: "MedicationRequest",
      params: [...baseParams("MedicationRequest", scope), ...sortCount("MedicationRequest")],
      purpose: "Lääkemääräykset (MedicationRequest)",
    };
  },
  allergies(scope: Scope): SearchSpec {
    return {
      resourceType: "AllergyIntolerance",
      params: [...baseParams("AllergyIntolerance", scope), ...sortCount("AllergyIntolerance")],
      purpose: "Allergiat ja intoleranssit",
    };
  },
  diagnosticReports(scope: Scope): SearchSpec {
    return {
      resourceType: "DiagnosticReport",
      params: [...baseParams("DiagnosticReport", scope), ...sortCount("DiagnosticReport")],
      purpose: "Lausunnot (DiagnosticReport)",
    };
  },
  documents(scope: Scope): SearchSpec {
    return {
      resourceType: "DocumentReference",
      params: [...baseParams("DocumentReference", scope), ...sortCount("DocumentReference")],
      purpose: "Asiakirjat (DocumentReference)",
    };
  },
};

export type BuilderName = keyof typeof builders;

// --- Potilas- ja kontaktihaut ---

export function patientSearch(query: string, demoOnly: boolean): SearchSpec {
  const q = query.trim();
  const params: [string, string][] = [];
  if (/^[A-Za-z0-9\-.]{1,64}$/.test(q) && /\d/.test(q)) {
    // Numeroita sisältävä merkkijono tulkitaan tunnisteeksi (id tai identifier).
    params.push(["_id", q]);
  } else if (q) {
    params.push(["name", q.slice(0, 80)]);
  }
  if (demoOnly) params.push(["_tag", `${DEMO_TAG_SYSTEM}|${DEMO_TAG_CODE}`]);
  params.push(["_count", String(PAGE_SIZE)]);
  return { resourceType: "Patient", params, purpose: "Potilashaku" };
}

export function patientIdentifierSearch(value: string, demoOnly: boolean): SearchSpec {
  const params: [string, string][] = [["identifier", value.slice(0, 120)]];
  if (demoOnly) params.push(["_tag", `${DEMO_TAG_SYSTEM}|${DEMO_TAG_CODE}`]);
  params.push(["_count", String(PAGE_SIZE)]);
  return { resourceType: "Patient", params, purpose: "Potilashaku identifierillä" };
}

export function encounterSearch(patientId: string): SearchSpec {
  return {
    resourceType: "Encounter",
    params: [
      ["patient", assertFhirId(patientId, "Patient-tunniste")],
      ["_sort", "-date"],
      ["_count", String(PAGE_SIZE)],
    ],
    purpose: "Potilaan palvelukontaktit",
  };
}
