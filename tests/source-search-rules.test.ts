import { describe, expect, it } from "vitest";
import { MAX_SEARCHES, planSearches, runAsk } from "../lib/clinical/ask";
import { MockLanguageAdapter } from "../lib/clinical/language-adapter";
import { mockInterpretQuestion } from "../lib/clinical/mock-language";
import type { EhrAdapter, SearchResult } from "../lib/fhir/ehr-adapter";
import type { SearchSpec } from "../lib/fhir/search-builders";
import { findSource } from "../lib/fhir/sources";

const today = "2026-10-15";
const ctx = { patientId: "p1" };
const overview = mockInterpretQuestion("Mikä potilaan tilanne on?", today);

const names = (flag?: boolean) => planSearches(overview, { ...ctx, observationsNeedCategory: flag }).map((s) => s.name);

describe("lähdekohtaiset hakusäännöt: Observation vaatii kategorian", () => {
  it("rekisterissä vain kategoriaa vaativa lähde (Epic) on merkitty, HAPI ei", () => {
    expect(findSource("epic")?.observationsNeedCategory).toBe(true);
    expect(findSource("hapi")?.observationsNeedCategory).toBeFalsy();
  });

  it("oletus: yhteenveto hakee kaikki havainnot yhdellä haulla", () => {
    expect(overview.intent).toBe("overview");
    expect(names()).toEqual(["conditions", "observations", "medicationStatements", "allergies", "diagnosticReports"]);
  });

  it("kategoriaa vaativalla lähteellä havainnot jaetaan vitaali- ja laboratoriohauiksi, eikä yhtään hakua pudoteta", () => {
    const n = names(true);
    expect(n).toEqual(["conditions", "vitalSigns", "laboratory", "medicationStatements", "allergies", "diagnosticReports"]);
    expect(n.length).toBeLessThanOrEqual(MAX_SEARCHES);
    const obs = planSearches(overview, { ...ctx, observationsNeedCategory: true }).filter((s) => s.spec.resourceType === "Observation");
    expect(obs).toHaveLength(2);
    for (const s of obs) expect(s.spec.params.some(([k]) => k === "category")).toBe(true);
  });

  it("muut kysymystyypit eivät muutu lipusta", () => {
    for (const q of ["Näytä viimeisimmät verenpaineet", "Mitä lääkkeitä potilaalla on?", "Millaisia verikokeita on otettu?"]) {
      const need = mockInterpretQuestion(q, today);
      const a = planSearches(need, { ...ctx }).map((s) => s.name);
      const b = planSearches(need, { ...ctx, observationsNeedCategory: true }).map((s) => s.name);
      expect(b).toEqual(a);
    }
  });
});

describe("hakuvirheiden selkeät viestit", () => {
  const stub = (status: number): EhrAdapter =>
    ({
      name: "stub",
      baseUrl: "https://example.org/fhir",
      searchForPatient: async (spec: SearchSpec): Promise<SearchResult> => ({
        state: "error",
        query: "Q",
        purpose: spec.purpose,
        resources: [],
        warnings: [],
        truncated: false,
        rejectedOtherPatient: 0,
        error: { kind: "http", status, message: `HTTP ${status}: salainen palvelimen teksti` },
      }),
    }) as unknown as EhrAdapter;

  const ask = (status: number) => runAsk({ question: "Mitä lääkkeitä potilaalla on?", patientId: "p1", today, language: new MockLanguageAdapter(), ehr: stub(status) });

  it("403: kertoo, ettei palvelin salli hakua sovellukselle, eikä toista palvelimen tekstiä", async () => {
    const r = await ask(403);
    expect(r.missing.length).toBeGreaterThan(0);
    for (const m of r.missing) {
      expect(m).toContain("HTTP 403");
      expect(m).toContain("ei salli tätä hakua tälle sovellukselle");
      expect(m).not.toContain("salainen palvelimen teksti");
    }
  });

  it("401: kehottaa kirjautumaan uudelleen", async () => {
    const r = await ask(401);
    expect(r.missing.every((m) => m.includes("HTTP 401") && m.includes("kirjaudu uudelleen"))).toBe(true);
  });

  it("muu virhe säilyttää aiemman viestin", async () => {
    const r = await ask(500);
    expect(r.missing.every((m) => m.includes("haku epäonnistui (HTTP 500"))).toBe(true);
  });
});
