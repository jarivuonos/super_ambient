// Kysymys → tarkistettu tiedontarve → sallitut lukuhaut → lähteisiin sidottu vastaus.

import type { EhrAdapter, SearchResult } from "../fhir/ehr-adapter";
import { builders, type BuilderName, type Scope } from "../fhir/search-builders";
import type { Resource } from "../fhir/types";
import {
  allergyFacts,
  bloodPressureFacts,
  conditionFacts,
  formatDate,
  medicationFacts,
  observationFacts,
  reportFacts,
  type Fact,
} from "./facts";
import { LanguageServiceUnavailable, parseWithRepair, type CapabilitySource, type ClinicalLanguageAdapter } from "./language-adapter";
import { mockAnswer } from "./mock-language";
import { InfoNeedSchema, type InfoNeed, type Intent } from "./schemas";

/** Enintään kuusi hakua: yhteenveto tarvitsee kuusi, kun lähde vaatii Observation-haulle kategorian (havainnot jaetaan kahtia). */
export const MAX_SEARCHES = 6;
export const MAX_TOTAL_RESOURCES = 150;

const INTENT_BUILDERS: Record<Intent, BuilderName[]> = {
  "blood-pressure": ["bloodPressure"],
  "vital-signs": ["vitalSigns"],
  laboratory: ["laboratory"],
  medications: ["medicationStatements", "medicationRequests"],
  allergies: ["allergies"],
  conditions: ["conditions"],
  "imaging-report": ["diagnosticReports", "documents"],
  documents: ["documents"],
  overview: ["conditions", "observations", "medicationStatements", "allergies", "diagnosticReports"],
  unknown: [],
};

const BUILDER_TYPE: Record<BuilderName, string> = {
  bloodPressure: "Observation",
  vitalSigns: "Observation",
  laboratory: "Observation",
  observations: "Observation",
  conditions: "Condition",
  medicationStatements: "MedicationStatement",
  medicationRequests: "MedicationRequest",
  allergies: "AllergyIntolerance",
  diagnosticReports: "DiagnosticReport",
  documents: "DocumentReference",
};

/** Muodostaa hakusuunnitelman. Potilas ja kontakti tulevat aina sovelluksen tilasta, ei mallilta. */
export function planSearches(need: InfoNeed, ctx: { patientId: string; encounterId?: string; observationsNeedCategory?: boolean }) {
  const scope: Scope = {
    patientId: ctx.patientId,
    encounterId: ctx.encounterId,
    encounterOnly: need.scope === "encounter" && !!ctx.encounterId,
    since: need.timeRange?.since ?? undefined,
  };
  let names = INTENT_BUILDERS[need.intent];
  // Mallin ilmoittamat resurssilajit voivat vain rajata intention hakuja, ei laajentaa niitä.
  if (need.resourceTypes.length) {
    const allowed = new Set<string>(need.resourceTypes);
    const narrowed = names.filter((n) => allowed.has(BUILDER_TYPE[n]));
    if (narrowed.length) names = narrowed;
  }
  if (ctx.observationsNeedCategory && names.includes("observations")) {
    // Lähde ei hyväksy kategoriatonta Observation-hakua: korvataan se vitaali- ja laboratoriohauilla (ilman kaksoiskappaleita).
    names = [...new Set(names.flatMap((n): BuilderName[] => (n === "observations" ? ["vitalSigns", "laboratory"] : [n])))];
  }
  return names.slice(0, MAX_SEARCHES).map((n) => ({ name: n, spec: builders[n](scope) }));
}

function factsFor(need: InfoNeed, name: BuilderName, resources: Resource[]): Fact[] {
  switch (name) {
    case "bloodPressure":
      return bloodPressureFacts(resources);
    case "vitalSigns":
    case "observations":
      return observationFacts(resources, "observation");
    case "laboratory":
      return observationFacts(resources, "lab");
    case "conditions":
      return conditionFacts(resources);
    case "medicationStatements":
    case "medicationRequests":
      return medicationFacts(resources);
    case "allergies":
      return allergyFacts(resources);
    case "diagnosticReports":
    case "documents":
      return reportFacts(resources);
  }
}

/** Kaikkien vastauksen lukujen täytyy löytyä faktoista (arvot tai päivämäärien osat). */
export function numbersGrounded(answer: string, facts: Fact[], extraTexts: string[] = []): { ok: boolean; ungrounded: string[] } {
  const allowed = new Set<string>();
  const add = (n: number | string) => allowed.add(String(n).replace(",", ".").replace(/^0+(?=\d)/, ""));
  for (const f of facts) {
    f.numbers.forEach(add);
    for (const m of `${f.text} ${f.date ?? ""} ${formatDate(f.date)} ${f.source.id} ${f.flags.join(" ")}`.matchAll(/\d+(?:[.,]\d+)?/g)) add(m[0]);
  }
  for (const t of extraTexts) for (const m of t.matchAll(/\d+(?:[.,]\d+)?/g)) add(m[0]);
  for (const n of [90, 30, 7, 365]) add(n); // sovelluksen omat rajausluvut
  const ungrounded: string[] = [];
  for (const m of answer.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const v = m[0].replace(",", ".").replace(/^0+(?=\d)/, "");
    if (!allowed.has(v)) ungrounded.push(m[0]);
  }
  return { ok: ungrounded.length === 0, ungrounded };
}

export interface SearchSummary {
  name: string;
  purpose: string;
  query: string;
  state: SearchResult["state"];
  count: number;
  total?: number;
  truncated: boolean;
  warnings: string[];
  rejectedOtherPatient: number;
  error?: { kind: string; message: string; status?: number };
}

export type AskState = "ok" | "empty" | "partial" | "error" | "clarify" | "service-unavailable";

export interface AskResponse {
  state: AskState;
  question: string;
  plan: InfoNeed | null;
  planSource: string;
  searches: SearchSummary[];
  facts: Fact[];
  answer: string;
  /** Kuka tulkitsi kysymyksen. */
  interpretedBy: CapabilitySource;
  /** Tulkinnan tekniset tiedot (esim. Jevin todennäköisyydet); näytetään vain lisätiedoissa. */
  interpretation: Record<string, unknown> | null;
  /** deterministic = koottu suoraan faktoista; deterministic-fallback = mallin vastaus hylättiin. */
  answerSource: "mock" | "model" | "deterministic" | "deterministic-fallback";
  missing: string[];
  notes: string[];
}

export async function runAsk(params: {
  question: string;
  patientId: string;
  encounterId?: string;
  today: string;
  language: ClinicalLanguageAdapter;
  ehr: EhrAdapter;
  signal?: AbortSignal;
}): Promise<AskResponse> {
  const { question, patientId, encounterId, language, ehr, signal } = params;
  const base: AskResponse = {
    state: "ok",
    question,
    plan: null,
    planSource: language.name,
    searches: [],
    facts: [],
    answer: "",
    interpretedBy: language.capabilities.interpretQuestion,
    interpretation: null,
    answerSource: language.capabilities.answer === "model" ? "model" : language.capabilities.answer === "mock" ? "mock" : "deterministic",
    missing: [],
    notes: [],
  };

  let raw: unknown;
  try {
    raw = await language.interpretQuestion(question, {
      today: params.today,
      hasEncounter: !!encounterId,
      signal,
      onDiagnostics: (d) => {
        base.interpretation = d as unknown as Record<string, unknown>;
      },
    });
  } catch (e) {
    if (e instanceof LanguageServiceUnavailable) {
      return { ...base, state: "service-unavailable", answer: e.message };
    }
    throw e;
  }
  const parsed = await parseWithRepair(raw, InfoNeedSchema, language.repair?.bind(language), 1);
  if (!parsed.ok) {
    return { ...base, state: "error", answer: "Kysymyksen tulkinta ei vastannut sallittua rakennetta, joten hakuja ei tehty.", notes: [parsed.error] };
  }
  const need = parsed.data;
  base.plan = need;
  if (need.intent === "unknown" || (need.clarificationQuestion && INTENT_BUILDERS[need.intent].length === 0)) {
    return { ...base, state: "clarify", answer: need.clarificationQuestion ?? "Tarkenna kysymystä." };
  }

  const planned = planSearches(need, { patientId, encounterId, observationsNeedCategory: ehr.observationsNeedCategory });
  let totalResources = 0;
  const facts: Fact[] = [];
  for (const { name, spec } of planned) {
    const remaining = MAX_TOTAL_RESOURCES - totalResources;
    if (remaining <= 0) {
      base.missing.push(`${spec.purpose}: hakua ei tehty, koska resurssien kokonaisraja (${MAX_TOTAL_RESOURCES}) täyttyi.`);
      base.searches.push({ name, purpose: spec.purpose, query: "", state: "partial", count: 0, truncated: true, warnings: [], rejectedOtherPatient: 0 });
      continue;
    }
    const res = await ehr.searchForPatient(spec, patientId, { maxPages: 3, maxResources: Math.min(60, remaining) }, signal);
    totalResources += res.resources.length;
    base.searches.push({
      name,
      purpose: res.purpose,
      query: res.query,
      state: res.state,
      count: res.resources.length,
      total: res.total,
      truncated: res.truncated,
      warnings: res.warnings,
      rejectedOtherPatient: res.rejectedOtherPatient,
      error: res.error ? { kind: res.error.kind, message: res.error.message, status: res.error.status } : undefined,
    });
    if (res.state === "error" && (res.error?.status === 401 || res.error?.status === 403)) {
      base.missing.push(
        res.error.status === 401
          ? `${spec.purpose}: palvelin hylkäsi tunnisteen (HTTP 401); kirjaudu uudelleen.`
          : `${spec.purpose}: palvelin ei salli tätä hakua tälle sovellukselle (HTTP 403); sovelluksen rekisteröinti ei välttämättä kata tätä tietotyyppiä.`,
      );
    } else if (res.state === "error") base.missing.push(`${spec.purpose}: haku epäonnistui (${res.error?.message ?? "tuntematon virhe"}).`);
    else if (res.state === "empty") base.missing.push(`${spec.purpose}: tästä hausta ei löytynyt tietoa.`);
    else if (res.state === "partial") base.missing.push(`${spec.purpose}: haku jäi osittaiseksi; kaikkia tietoja ei haettu (raja tai keskeytynyt sivutus).`);
    facts.push(...factsFor(need, name, res.resources));
  }
  base.facts = facts;

  const states = base.searches.map((s) => s.state);
  if (states.length && states.every((s) => s === "error")) base.state = "error";
  else if (states.some((s) => s === "error" || s === "partial")) base.state = "partial";
  else if (facts.length === 0) base.state = "empty";

  if (base.state === "error") {
    base.answer = "Tietojen haku epäonnistui. Vastausta ei muodostettu.";
    return base;
  }

  let answer: string;
  try {
    answer = await language.answer(question, need, facts, base.missing);
  } catch (e) {
    if (!(e instanceof LanguageServiceUnavailable)) throw e;
    answer = mockAnswer(need, facts, base.missing);
    base.answerSource = "deterministic-fallback";
    base.notes.push(e.message);
  }
  const grounded = numbersGrounded(answer, facts, [
    ...(need.timeRange?.since ? [need.timeRange.since, formatDate(need.timeRange.since)] : []),
    ...base.missing,
  ]);
  if (!grounded.ok) {
    base.notes.push(`Mallin vastauksessa oli lähteisiin sitomattomia lukuja (${grounded.ungrounded.join(", ")}); näytetään faktoista koottu vastaus.`);
    answer = mockAnswer(need, facts, base.missing);
    base.answerSource = "deterministic-fallback";
  }
  base.answer = answer;
  return base;
}
