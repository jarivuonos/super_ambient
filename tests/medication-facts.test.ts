import { describe, expect, it } from "vitest";
import { medicationFacts, medicationName } from "../lib/clinical/facts";
import type { Resource } from "../lib/fhir/types";

const req = (extra: Record<string, unknown>): Resource =>
  ({ resourceType: "MedicationRequest", id: "mr1", status: "active", authoredOn: "2026-09-01", ...extra }) as Resource;

describe("lääkkeen nimi", () => {
  it("käyttää ensisijaisesti medicationCodeableConceptia", () => {
    const r = req({ medicationCodeableConcept: { text: "Metoprololi 50 mg" }, medicationReference: { reference: "Medication/m1", display: "Muu" } });
    expect(medicationName(r)).toBe("Metoprololi 50 mg");
  });

  it("lukee nimen viitteen display-kentästä (Epic antaa lääkkeen viitteenä)", () => {
    expect(medicationName(req({ medicationReference: { reference: "Medication/m1", display: "  lisinopril 10 MG Oral Tablet " } }))).toBe("lisinopril 10 MG Oral Tablet");
  });

  it("lukee nimen sisältyvästä Medication-resurssista, kun viite on #id", () => {
    const r = req({
      medicationReference: { reference: "#med1" },
      contained: [{ resourceType: "Medication", id: "med1", code: { coding: [{ display: "Amoksisilliini 500 mg" }] } }],
    });
    expect(medicationName(r)).toBe("Amoksisilliini 500 mg");
  });

  it("ei arvaa nimeä: tyhjä display tai puuttuva sisältö jättää (nimeämätön)", () => {
    expect(medicationName(req({ medicationReference: { reference: "Medication/m1", display: "  " } }))).toBe("(nimeämätön)");
    expect(medicationName(req({ medicationReference: { reference: "#x" }, contained: [{ resourceType: "Medication", id: "y" }] }))).toBe("(nimeämätön)");
    expect(medicationName(req({}))).toBe("(nimeämätön)");
  });

  it("faktat käyttävät nimeä sekä lääkemääräyksessä että lääkityskirjauksessa", () => {
    const stmt = { resourceType: "MedicationStatement", id: "ms1", status: "active", medicationReference: { display: "Aspiriini 100 mg" } } as Resource;
    const facts = medicationFacts([req({ medicationReference: { display: "Lisinopriili 10 mg" } }), stmt], new Date("2026-10-15"));
    expect(facts.map((f) => f.text).join("|")).toContain("Lisinopriili 10 mg");
    expect(facts.map((f) => f.text).join("|")).toContain("Aspiriini 100 mg");
    expect(facts.every((f) => !f.text.includes("(nimeämätön)"))).toBe(true);
  });
});
