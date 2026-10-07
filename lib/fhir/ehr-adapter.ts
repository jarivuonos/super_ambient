import type { FhirError } from "./http";
import type { SearchSpec } from "./search-builders";
import type { Bundle, Encounter, OperationOutcomeIssue, Patient, Resource } from "./types";

export interface CapabilitySummary {
  fhirVersion?: string;
  software?: string;
  transaction: boolean;
  resources: Record<
    string,
    { read: boolean; search: boolean; create: boolean; conditionalCreate: boolean; searchParams: string[] }
  >;
}

export type CapabilityCheck =
  | { ok: true; checkedAt: string; summary: CapabilitySummary }
  | { ok: false; checkedAt: string; error: FhirError; lastSuccessAt?: string };

export type SearchState = "ok" | "empty" | "partial" | "error";

export interface SearchResult<T extends Resource = Resource> {
  state: SearchState;
  query: string;
  purpose: string;
  resources: T[];
  /** Palvelimen varoitukset (OperationOutcome tai search.mode=outcome). */
  warnings: string[];
  /** Jäikö tietoja hakematta sivu- tai resurssirajan vuoksi. */
  truncated: boolean;
  /** Toiselle potilaalle kuuluneet, pois suodatetut resurssit. */
  rejectedOtherPatient: number;
  total?: number;
  error?: FhirError;
}

export interface SearchLimits {
  maxPages: number;
  maxResources: number;
}

export interface TransactionEntryResult {
  index: number;
  status: string;
  ok: boolean;
  location?: string;
  /** `Type/id` palvelimen palauttamasta sijainnista. */
  reference?: string;
  /** true jos ifNoneExist löysi olemassa olevan resurssin (200 OK). */
  existing: boolean;
  issues?: OperationOutcomeIssue[];
}

export type TransactionResult =
  | { state: "accepted"; entries: TransactionEntryResult[] }
  | { state: "rejected"; error: FhirError; entries?: TransactionEntryResult[] }
  | { state: "unknown"; error: FhirError };

export interface ValidationResult {
  ok: boolean;
  issues: OperationOutcomeIssue[];
  /** Validointia ei voitu suorittaa (esim. yhteysvirhe). */
  unavailable?: string;
}

/** EHR-liitännän rajapinta. Jokainen EHR tarvitsee oman toteutuksen ja yhteensopivuustestit. */
export interface EhrAdapter {
  readonly name: string;
  readonly baseUrl: string;
  checkCapabilities(signal?: AbortSignal): Promise<CapabilityCheck>;
  searchPatients(query: string, demoOnly: boolean, signal?: AbortSignal): Promise<SearchResult<Patient>>;
  searchEncounters(patientId: string, signal?: AbortSignal): Promise<SearchResult<Encounter>>;
  /** Potilaskohtainen haku; palautetut resurssit tarkistetaan potilasta vasten. */
  searchForPatient(spec: SearchSpec, patientId: string, limits?: SearchLimits, signal?: AbortSignal): Promise<SearchResult>;
  read<T extends Resource = Resource>(resourceType: string, id: string, signal?: AbortSignal): Promise<{ ok: true; resource: T } | { ok: false; error: FhirError }>;
  validate(resource: Resource, signal?: AbortSignal): Promise<ValidationResult>;
  transaction(bundle: Bundle, signal?: AbortSignal): Promise<TransactionResult>;
  findByIdentifier(resourceType: string, system: string, value: string, signal?: AbortSignal): Promise<SearchResult>;
}
