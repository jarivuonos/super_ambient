import { describe, expect, it } from "vitest";
import { planSearches } from "../lib/clinical/ask";
import { InfoNeedSchema, type InfoNeed } from "../lib/clinical/schemas";
import { assertFhirId, builders, encounterSearch, patientSearch, toQueryPath } from "../lib/fhir/search-builders";

const need = (p: Partial<InfoNeed>): InfoNeed => ({
  intent: "blood-pressure",
  resourceTypes: [],
  concepts: [],
  timeRange: null,
  scope: "patient",
  clarificationQuestion: null,
  rationale: "",
  ...p,
});

describe("hakurakentajat", () => {
  it("verenpainehaku käyttää LOINC-koodeja, lajittelua ja sivukokoa", () => {
    const path = toQueryPath(builders.bloodPressure({ patientId: "123" }));
    const u = new URLSearchParams(path.split("?")[1]);
    expect(path.startsWith("Observation?")).toBe(true);
    expect(u.get("patient")).toBe("123");
    expect(u.get("code")).toContain("http://loinc.org|85354-9");
    expect(u.get("code")).toContain("http://loinc.org|8480-6");
    expect(u.get("_sort")).toBe("-date");
    expect(u.get("_count")).toBe("20");
    expect(u.has("encounter")).toBe(false); // pitkittäiskysely ei rajaudu kontaktiin
    expect(path).toContain("code=http%3A%2F%2Floinc.org%7C85354-9"); // arvot koodataan
  });

  it("kontaktirajaus vain pyydettäessä ja vain tuetuille resursseille", () => {
    const withEnc = builders.bloodPressure({ patientId: "1", encounterId: "9", encounterOnly: true });
    expect(withEnc.params).toContainEqual(["encounter", "9"]);
    const allergy = builders.allergies({ patientId: "1", encounterId: "9", encounterOnly: true });
    expect(allergy.params.find(([k]) => k === "encounter")).toBeUndefined();
  });

  it("aikarajaus lisätään date-parametrina", () => {
    expect(builders.laboratory({ patientId: "1", since: "2026-01-01" }).params).toContainEqual(["date", "ge2026-01-01"]);
    expect(builders.laboratory({ patientId: "1", since: "x&_id=2" }).params.find(([k]) => k === "date")).toBeUndefined();
  });

  it("hylkää tunnisteet, joilla yritetään muuttaa hakua", () => {
    expect(() => assertFhirId("1&patient=2")).toThrow();
    expect(() => builders.conditions({ patientId: "../Patient/2" })).toThrow();
    expect(() => encounterSearch("a b")).toThrow();
  });

  it("potilashaku: numeroita sisältävä id, muuten nimi; demotunniste", () => {
    expect(patientSearch("12345", true).params).toContainEqual(["_id", "12345"]);
    expect(patientSearch("Aino", false).params).toContainEqual(["name", "Aino"]);
    expect(patientSearch("Aino", true).params.some(([k]) => k === "_tag")).toBe(true);
  });
});

describe("tiedontarpeen skeema ja hakusuunnitelma", () => {
  it("malli ei voi antaa URL:ää, potilasta tai metodia", () => {
    const base = need({});
    expect(InfoNeedSchema.safeParse(base).success).toBe(true);
    expect(InfoNeedSchema.safeParse({ ...base, url: "http://evil/Patient" }).success).toBe(false);
    expect(InfoNeedSchema.safeParse({ ...base, patientId: "999" }).success).toBe(false);
    expect(InfoNeedSchema.safeParse({ ...base, method: "DELETE" }).success).toBe(false);
    expect(InfoNeedSchema.safeParse({ ...base, resourceTypes: ["Patient"] }).success).toBe(false);
  });

  it("potilas tulee aina sovelluksen tilasta", () => {
    const plan = planSearches(need({}), { patientId: "42" });
    expect(plan).toHaveLength(1);
    expect(plan[0].spec.params).toContainEqual(["patient", "42"]);
  });

  it("mallin resurssilajit voivat vain rajata, eivät laajentaa", () => {
    const narrowed = planSearches(need({ intent: "medications", resourceTypes: ["MedicationStatement"] }), { patientId: "1" });
    expect(narrowed.map((p) => p.spec.resourceType)).toEqual(["MedicationStatement"]);
    const widened = planSearches(need({ intent: "allergies", resourceTypes: ["Observation"] }), { patientId: "1" });
    expect(widened.map((p) => p.spec.resourceType)).toEqual(["AllergyIntolerance"]);
  });

  it("hakujen määrä on rajattu", () => {
    expect(planSearches(need({ intent: "overview" }), { patientId: "1" }).length).toBeLessThanOrEqual(5);
    expect(planSearches(need({ intent: "unknown" }), { patientId: "1" })).toHaveLength(0);
  });
});
