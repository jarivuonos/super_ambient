import type {
  CapabilityCheck,
  CapabilitySummary,
  EhrAdapter,
  SearchLimits,
  SearchResult,
  TransactionEntryResult,
  TransactionResult,
  ValidationResult,
} from "./ehr-adapter";
import { FhirHttp, describeIssues, isAllowedUrl, operationOutcomeIssues, type FhirHttpOptions } from "./http";
import { filterToPatient, normalizeReference } from "./patient-guard";
import {
  assertFhirId,
  encounterSearch,
  patientIdentifierSearch,
  patientSearch,
  toQueryPath,
  type SearchSpec,
} from "./search-builders";
import type { Bundle, Encounter, OperationOutcomeIssue, Patient, Resource } from "./types";

export const DEFAULT_LIMITS: SearchLimits = { maxPages: 3, maxResources: 60 };

interface CapRestResource {
  type: string;
  interaction?: { code: string }[];
  conditionalCreate?: boolean;
  searchParam?: { name: string }[];
}

export function summarizeCapabilityStatement(cs: Resource): CapabilitySummary {
  if (cs.resourceType !== "CapabilityStatement") {
    throw new Error(`Odotettiin CapabilityStatement-resurssia, saatiin ${cs.resourceType}`);
  }
  const rest = ((cs.rest as { mode?: string; interaction?: { code: string }[]; resource?: CapRestResource[] }[]) ?? []).find(
    (r) => r.mode === "server" || !r.mode,
  );
  const resources: CapabilitySummary["resources"] = {};
  for (const r of rest?.resource ?? []) {
    const codes = new Set((r.interaction ?? []).map((i) => i.code));
    resources[r.type] = {
      read: codes.has("read"),
      search: codes.has("search-type"),
      create: codes.has("create"),
      conditionalCreate: Boolean(r.conditionalCreate),
      searchParams: (r.searchParam ?? []).map((p) => p.name),
    };
  }
  const software = cs.software as { name?: string; version?: string } | undefined;
  return {
    fhirVersion: cs.fhirVersion as string | undefined,
    software: software ? `${software.name ?? ""} ${software.version ?? ""}`.trim() : undefined,
    transaction: Boolean(rest?.interaction?.some((i) => i.code === "transaction")),
    resources,
  };
}

function outcomeWarnings(bundle: Bundle): string[] {
  const out: string[] = [];
  for (const e of bundle.entry ?? []) {
    if (e.search?.mode === "outcome" && e.resource) {
      const issues = operationOutcomeIssues(e.resource);
      if (issues?.length) out.push(describeIssues(issues));
    }
  }
  return out;
}

export function parseTransactionResponse(body: Bundle, baseUrl: string): TransactionEntryResult[] {
  return (body.entry ?? []).map((e, index) => {
    const status = e.response?.status ?? "";
    const code = parseInt(status, 10);
    const location = e.response?.location;
    const issues = operationOutcomeIssues(e.response?.outcome);
    return {
      index,
      status,
      ok: code >= 200 && code < 300,
      location,
      reference: normalizeReference(location, baseUrl),
      existing: code === 200,
      issues,
    };
  });
}

export class HapiR4Adapter implements EhrAdapter {
  readonly name = "HAPI FHIR R4";
  readonly baseUrl: string;
  private http: FhirHttp;
  private lastSuccessAt?: string;
  /** Viimeisin onnistunut kyvykkyystieto; hakuehdot tarkistetaan sitä vasten. */
  private capabilities?: CapabilitySummary;

  constructor(opts: FhirHttpOptions) {
    this.http = new FhirHttp(opts);
    this.baseUrl = this.http.baseUrl;
  }

  async checkCapabilities(signal?: AbortSignal): Promise<CapabilityCheck> {
    const res = await this.http.get("metadata", signal);
    const checkedAt = new Date().toISOString();
    if (!res.ok) return { ok: false, checkedAt, error: res.error, lastSuccessAt: this.lastSuccessAt };
    try {
      const summary = summarizeCapabilityStatement(res.body);
      this.lastSuccessAt = checkedAt;
      this.capabilities = summary;
      return { ok: true, checkedAt, summary };
    } catch (e) {
      return {
        ok: false,
        checkedAt,
        error: { kind: "invalid-json", message: (e as Error).message },
        lastSuccessAt: this.lastSuccessAt,
      };
    }
  }

  private async searchPaged(spec: SearchSpec, limits: SearchLimits, signal?: AbortSignal): Promise<SearchResult> {
    const query = toQueryPath(spec);
    const result: SearchResult = {
      state: "ok",
      query,
      purpose: spec.purpose,
      resources: [],
      warnings: [],
      truncated: false,
      rejectedOtherPatient: 0,
    };
    const unsupported = this.unsupportedParams(spec);
    if (unsupported.length) {
      return {
        ...result,
        state: "error",
        error: { kind: "http", message: `Palvelin ei ilmoita tukevansa hakuehtoa ${unsupported.join(", ")} resurssille ${spec.resourceType}; hakua ei lähetetty.` },
      };
    }
    let next: string | undefined = query;
    let pages = 0;
    while (next) {
      if (pages >= limits.maxPages || result.resources.length >= limits.maxResources) {
        result.truncated = true;
        break;
      }
      const res: Awaited<ReturnType<FhirHttp["get"]>> = await this.http.get<Bundle>(next, signal);
      pages++;
      if (!res.ok) {
        if (pages === 1) return { ...result, state: "error", error: res.error };
        // Myöhempi sivu epäonnistui: palautetaan osittainen tulos.
        result.state = "partial";
        result.truncated = true;
        result.error = res.error;
        break;
      }
      const bundle = res.body as Bundle;
      if (bundle.resourceType !== "Bundle") {
        return { ...result, state: "error", error: { kind: "invalid-json", message: "Hakuvastaus ei ollut Bundle." } };
      }
      if (pages === 1 && typeof bundle.total === "number") result.total = bundle.total;
      result.warnings.push(...outcomeWarnings(bundle));
      for (const e of bundle.entry ?? []) {
        if (e.resource && e.search?.mode !== "outcome" && e.resource.resourceType === spec.resourceType) {
          if (result.resources.length < limits.maxResources) result.resources.push(e.resource);
          else result.truncated = true;
        }
      }
      const nextUrl = bundle.link?.find((l) => l.relation === "next")?.url;
      if (nextUrl && !isAllowedUrl(nextUrl, this.baseUrl)) {
        result.warnings.push("Sivutuslinkki osoitti sallitun palvelimen ulkopuolelle; sitä ei seurattu.");
        result.truncated = true;
        next = undefined;
      } else {
        next = nextUrl;
      }
    }
    if (result.truncated && result.state === "ok") result.state = "partial";
    if (result.resources.length === 0 && result.state === "ok") result.state = "empty";
    return result;
  }

  /** Hakuehdot, joita CapabilityStatement ei listaa (yleiset _-parametrit ohitetaan). */
  unsupportedParams(spec: SearchSpec): string[] {
    const res = this.capabilities?.resources[spec.resourceType];
    if (!this.capabilities) return [];
    if (!res) return [`(resurssi ${spec.resourceType})`];
    return [...new Set(spec.params.map(([k]) => k).filter((k) => !k.startsWith("_") && !res.searchParams.includes(k)))];
  }

  async searchPatients(query: string, demoOnly: boolean, signal?: AbortSignal): Promise<SearchResult<Patient>> {
    const q = query.trim();
    // `system|value` tulkitaan identifier-hauksi.
    const spec = q.includes("|") ? patientIdentifierSearch(q, demoOnly) : patientSearch(q, demoOnly);
    return (await this.searchPaged(spec, { maxPages: 1, maxResources: 20 }, signal)) as SearchResult<Patient>;
  }

  async searchEncounters(patientId: string, signal?: AbortSignal): Promise<SearchResult<Encounter>> {
    const res = await this.searchPaged(encounterSearch(patientId), { maxPages: 1, maxResources: 20 }, signal);
    const { kept, rejected } = filterToPatient(res.resources, patientId, this.baseUrl);
    return { ...res, resources: kept as Encounter[], rejectedOtherPatient: rejected };
  }

  async searchForPatient(spec: SearchSpec, patientId: string, limits = DEFAULT_LIMITS, signal?: AbortSignal): Promise<SearchResult> {
    assertFhirId(patientId, "Patient-tunniste");
    const patientParam = spec.params.find(([k]) => k === "patient")?.[1];
    if (patientParam !== patientId) throw new Error("Hakuehto ei rajaudu valittuun potilaaseen.");
    const res = await this.searchPaged(spec, limits, signal);
    const { kept, rejected } = filterToPatient(res.resources, patientId, this.baseUrl);
    const out = { ...res, resources: kept, rejectedOtherPatient: rejected };
    if (rejected) out.warnings = [...out.warnings, `${rejected} toiselle potilaalle kuulunutta resurssia suodatettiin pois.`];
    if (kept.length === 0 && out.state !== "error") out.state = res.truncated ? "partial" : "empty";
    return out;
  }

  async read<T extends Resource = Resource>(resourceType: string, id: string, signal?: AbortSignal) {
    if (!/^[A-Z][A-Za-z]+$/.test(resourceType)) throw new Error("Virheellinen resurssityyppi");
    assertFhirId(id);
    const res = await this.http.get<T>(`${resourceType}/${id}`, signal);
    if (!res.ok) return { ok: false as const, error: res.error };
    if (res.body.resourceType !== resourceType || res.body.id !== id) {
      return { ok: false as const, error: { kind: "invalid-json" as const, message: "Palautettu resurssi ei vastannut pyydettyä." } };
    }
    return { ok: true as const, resource: res.body };
  }

  async validate(resource: Resource, signal?: AbortSignal): Promise<ValidationResult> {
    if (!/^[A-Z][A-Za-z]+$/.test(resource.resourceType)) throw new Error("Virheellinen resurssityyppi");
    // $validate ei muuta palvelimen tietoja.
    const res = await this.http.post(`${resource.resourceType}/$validate`, resource, signal);
    const body = res.ok ? res.body : undefined;
    const issues: OperationOutcomeIssue[] | undefined = res.ok ? operationOutcomeIssues(body) : res.error.issues;
    if (!res.ok && !issues) return { ok: false, issues: [], unavailable: res.error.message };
    const list = issues ?? [];
    return { ok: !list.some((i) => i.severity === "error" || i.severity === "fatal"), issues: list };
  }

  async transaction(bundle: Bundle, signal?: AbortSignal): Promise<TransactionResult> {
    if (bundle.resourceType !== "Bundle" || bundle.type !== "transaction") {
      throw new Error("Vain transaction-Bundle sallitaan.");
    }
    const res = await this.http.post<Bundle>("", bundle, signal);
    if (!res.ok) {
      if (res.error.kind === "timeout" || res.error.kind === "network") return { state: "unknown", error: res.error };
      return { state: "rejected", error: res.error };
    }
    if (res.body?.resourceType !== "Bundle" || res.body.type !== "transaction-response") {
      return { state: "unknown", error: { kind: "invalid-json", message: "Vastaus ei ollut transaction-response." } };
    }
    const entries = parseTransactionResponse(res.body, this.baseUrl);
    if (entries.length !== (bundle.entry?.length ?? 0) || entries.some((e) => !e.ok || !e.reference)) {
      return {
        state: "rejected",
        error: { kind: "http", message: "Transaction-vastauksen entryt eivät vastanneet pyyntöä." },
        entries,
      };
    }
    return { state: "accepted", entries };
  }

  async findByIdentifier(resourceType: string, system: string, value: string, signal?: AbortSignal): Promise<SearchResult> {
    if (!/^[A-Z][A-Za-z]+$/.test(resourceType)) throw new Error("Virheellinen resurssityyppi");
    const spec: SearchSpec = {
      resourceType: resourceType as SearchSpec["resourceType"],
      params: [
        ["identifier", `${system}|${value}`],
        ["_count", "5"],
      ],
      purpose: "Tunnisteella haku",
    };
    return this.searchPaged(spec, { maxPages: 1, maxResources: 5 }, signal);
  }
}
