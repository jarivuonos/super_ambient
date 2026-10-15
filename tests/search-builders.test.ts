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

describe("potilashaun nimimuoto", () => {
  const q = (spec: { params: [string, string][] }) => spec.params.filter(([k]) => !k.startsWith("_")).map(([k, v]) => `${k}=${v}`);

  it("oletus: yksi name-parametri", () => {
    expect(q(patientSearch("Warren McGinnis", false))).toEqual(["name=Warren McGinnis"]);
  });

  it("family-given: yksi sana on sukunimi", () => {
    expect(q(patientSearch("McGinnis", false, "family-given"))).toEqual(["family=McGinnis"]);
  });

  it("family-given: 'Etunimi Sukunimi' ja 'Sukunimi, Etunimi' antavat saman haun; keskinimet ohitetaan", () => {
    const want = ["family=McGinnis", "given=Warren"];
    expect(q(patientSearch("Warren McGinnis", false, "family-given"))).toEqual(want);
    expect(q(patientSearch("McGinnis, Warren", false, "family-given"))).toEqual(want);
    expect(q(patientSearch("Warren James McGinnis", false, "family-given"))).toEqual(want);
  });

  it("numeroita sisältävä haku on edelleen tunnistehaku kaikilla nimimuodoilla", () => {
    expect(patientSearch("e0w0LEDC.1", false, "family-given").params).toContainEqual(["_id", "e0w0LEDC.1"]);
  });

  it("tyhjä haku ei lisää nimiparametreja", () => {
    expect(q(patientSearch("  ", false, "family-given"))).toEqual([]);
  });

  it("family-given: syntymäaika (ISO tai p.k.vvvv) ja sukupuoli tulevat omiksi hakuehdoikseen", () => {
    const want = ["family=McGinnis", "given=Warren", "birthdate=1952-05-24", "gender=male"];
    expect(q(patientSearch("Warren McGinnis 1952-05-24 male", false, "family-given"))).toEqual(want);
    expect(q(patientSearch("McGinnis, Warren 24.5.1952 mies", false, "family-given"))).toEqual(want);
  });

  it("virheellinen päivämäärä ei muutu hakuehdoksi", () => {
    expect(q(patientSearch("Warren McGinnis 31.2.1952", false, "family-given")).some((p) => p.startsWith("birthdate"))).toBe(false);
  });

  it("oletusmuoto (name) ei erottele päivää tai sukupuolta", () => {
    expect(q(patientSearch("Warren McGinnis 1952-05-24", false))).toEqual(["name=Warren McGinnis 1952-05-24"]);
  });
});
