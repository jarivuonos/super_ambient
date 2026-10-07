import { describe, expect, it } from "vitest";
import { builders } from "../lib/fhir/search-builders";
import { isAllowedUrl } from "../lib/fhir/http";
import { BASE } from "./fake-fhir";
import { setup } from "./helpers";

describe("HapiR4Adapter", () => {
  it("lukee CapabilityStatementin", async () => {
    const { ehr } = setup();
    const c = await ehr.checkCapabilities();
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.summary.transaction).toBe(true);
      expect(c.summary.resources.Observation.conditionalCreate).toBe(true);
    }
  });

  it("tyhjä, onnistunut ja virheellinen haku ovat eri tiloja", async () => {
    const { ehr, idOf, fake } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    const p2 = idOf("Patient", "demo-patient-2");
    expect((await ehr.searchForPatient(builders.bloodPressure({ patientId: p1 }), p1)).state).toBe("ok");
    expect((await ehr.searchForPatient(builders.bloodPressure({ patientId: p2 }), p2)).state).toBe("empty");
    fake.hooks.push((u) =>
      u.pathname.endsWith("/Condition") ? fake.json(400, { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "invalid", diagnostics: "Unknown search parameter" }] }) : undefined,
    );
    const err = await ehr.searchForPatient(builders.conditions({ patientId: p1 }), p1);
    expect(err.state).toBe("error");
    expect(err.error?.issues?.[0].diagnostics).toBe("Unknown search parameter");
  });

  it("sivutus- ja resurssiraja tuottaa osittaisen tuloksen", async () => {
    const { ehr, idOf, fake } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    for (let i = 0; i < 50; i++) fake.put({ resourceType: "Observation", subject: { reference: `Patient/${p1}` }, code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] } });
    const r = await ehr.searchForPatient(builders.observations({ patientId: p1 }), p1, { maxPages: 2, maxResources: 100 });
    expect(r.state).toBe("partial");
    expect(r.truncated).toBe(true);
    expect(r.resources.length).toBe(40);
  });

  it("ei seuraa sallitun palvelimen ulkopuolista sivutuslinkkiä", async () => {
    const { ehr, idOf, fake } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    fake.hooks.push((u) =>
      u.pathname.endsWith("/AllergyIntolerance")
        ? fake.json(200, { resourceType: "Bundle", type: "searchset", entry: [], link: [{ relation: "next", url: "https://evil.example/baseR4/AllergyIntolerance?page=2" }] })
        : undefined,
    );
    const r = await ehr.searchForPatient(builders.allergies({ patientId: p1 }), p1);
    expect(r.truncated).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/ulkopuolelle/);
    expect(fake.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("suodattaa toisen potilaan resurssit pois", async () => {
    const { ehr, idOf, fake } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    const p2 = idOf("Patient", "demo-patient-2");
    fake.hooks.push((u) =>
      u.pathname.endsWith("/AllergyIntolerance")
        ? fake.json(200, { resourceType: "Bundle", type: "searchset", entry: [{ resource: { resourceType: "AllergyIntolerance", id: "x", patient: { reference: `Patient/${p2}` } } }] })
        : undefined,
    );
    const r = await ehr.searchForPatient(builders.allergies({ patientId: p1 }), p1);
    expect(r.resources).toEqual([]);
    expect(r.rejectedOtherPatient).toBe(1);
  });

  it("hakuvastauksen OperationOutcome-varoitukset näytetään", async () => {
    const { ehr, idOf, fake } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    fake.hooks.push((u) =>
      u.pathname.endsWith("/Condition")
        ? fake.json(200, { resourceType: "Bundle", type: "searchset", entry: [{ search: { mode: "outcome" }, resource: { resourceType: "OperationOutcome", issue: [{ severity: "warning", code: "processing", diagnostics: "Parametri ohitettiin" }] } }] })
        : undefined,
    );
    const r = await ehr.searchForPatient(builders.conditions({ patientId: p1 }), p1);
    expect(r.state).toBe("empty");
    expect(r.warnings[0]).toMatch(/Parametri ohitettiin/);
  });

  it("yhteyskatko: lukuyritykset uusitaan rajatusti ja virhe raportoidaan", async () => {
    const { ehr, fake } = setup();
    fake.hooks.push(() => {
      throw new TypeError("fetch failed");
    });
    const r = await ehr.searchPatients("Aino", true);
    expect(r.state).toBe("error");
    expect(r.error?.kind).toBe("network");
    expect(fake.calls.length).toBe(3); // 1 + 2 uusintaa
  });

  it("transaction-kirjoitusta ei uusita automaattisesti ja aikakatkaisu on tuntematon tila", async () => {
    const { ehr, fake } = setup();
    fake.hooks.push((u, init) => {
      if (init.method === "POST") return new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      return undefined;
    });
    const r = await ehr.transaction({ resourceType: "Bundle", type: "transaction", entry: [] });
    expect(r.state).toBe("unknown");
    expect(fake.calls.filter((c) => c.method === "POST").length).toBe(1);
  }, 10000);

  it("URL-tarkistus", () => {
    expect(isAllowedUrl(`${BASE}/Patient?x=1`, BASE)).toBe(true);
    expect(isAllowedUrl("https://fake.fhir.test/other/Patient", BASE)).toBe(false);
    expect(isAllowedUrl("http://fake.fhir.test/baseR4/Patient", BASE)).toBe(false);
    expect(isAllowedUrl("https://u:p@fake.fhir.test/baseR4/Patient", BASE)).toBe(false);
  });
});

describe("hakuehtojen tarkistus CapabilityStatementia vasten", () => {
  it("palvelimen ilmoittamaton hakuehto estää haun", async () => {
    const { ehr, idOf, fake } = setup();
    const cap = fake.capability();
    fake.hooks.push((u) => {
      if (!u.pathname.endsWith("/metadata")) return undefined;
      const obs = cap.rest[0].resource.find((r) => r.type === "Observation")!;
      obs.searchParam = obs.searchParam.filter((p) => p.name !== "code");
      return fake.json(200, cap);
    });
    await ehr.checkCapabilities();
    const p1 = idOf("Patient", "demo-patient-1");
    const before = fake.calls.length;
    const r = await ehr.searchForPatient(builders.bloodPressure({ patientId: p1 }), p1);
    expect(r.state).toBe("error");
    expect(r.error?.message).toMatch(/hakuehtoa code/);
    expect(fake.calls.length).toBe(before);
  });
});
