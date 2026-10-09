import { describe, expect, it } from "vitest";
import { numbersGrounded, runAsk } from "../lib/clinical/ask";
import { MockLanguageAdapter, UnavailableLanguageAdapter, type ClinicalLanguageAdapter } from "../lib/clinical/language-adapter";
import { setup } from "./helpers";

const lang = new MockLanguageAdapter();
const today = "2026-10-07";

describe("kysy potilastiedoista", () => {
  it("viimeisimmät verenpaineet: oikean potilaan arvo, yksikkö, mittausaika ja lähde", async () => {
    const { ehr, idOf } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    const r = await runAsk({ question: "Näytä viimeisimmät verenpaineet", patientId: p1, today, language: lang, ehr });
    expect(r.state).toBe("ok");
    const latest = r.facts[0];
    expect(latest.text).toBe("138/88 mmHg");
    expect(latest.date).toBe("2026-10-01T07:45:00+03:00");
    expect(latest.source.resourceType).toBe("Observation");
    expect(latest.source.fields).toContain("component[0].valueQuantity");
    expect(latest.source.fields).toContain("effectiveDateTime");
    expect(r.answer).toMatch(/138\/88 mmHg/);
    expect(r.answer).toContain(`Observation/${latest.source.id}`);
    // Erilliset systolinen ja diastolinen pysyvät erillään
    expect(r.facts.filter((f) => f.kind === "bp-systolic")).toHaveLength(1);
    expect(r.facts.filter((f) => f.kind === "bp-diastolic")).toHaveLength(1);
    expect(r.facts.every((f) => !f.text.includes("141/87"))).toBe(true);
  });

  it("ei verenpainemittauksia: tietopuute, ei keksittyjä arvoja", async () => {
    const { ehr, idOf } = setup();
    const p2 = idOf("Patient", "demo-patient-2");
    const r = await runAsk({ question: "Näytä viimeisimmät verenpaineet", patientId: p2, today, language: lang, ehr });
    expect(r.state).toBe("empty");
    expect(r.facts).toEqual([]);
    expect(r.answer).toMatch(/ei löytynyt verenpainemittauksia/);
    expect(r.answer).toMatch(/ei tarkoita/);
    expect(r.answer).not.toMatch(/\d+\/\d+/);
  });

  it("erilliset systolinen/diastolinen samalta ajalta: selkeästi nimetty, rinnakkain mutta ei pariksi yhdistetty", async () => {
    const { ehr, idOf, fake } = setup();
    const p2 = idOf("Patient", "demo-patient-2");
    const obs = (code: string, display: string, value: number) =>
      fake.put({
        resourceType: "Observation",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code, display }] },
        subject: { reference: `Patient/${p2}` },
        effectiveDateTime: "2026-01-15T09:00:00+02:00",
        valueQuantity: { value, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
      });
    obs("8480-6", "Systolic blood pressure", 135);
    obs("8462-4", "Diastolic blood pressure", 91);
    const r = await runAsk({ question: "Näytä viimeisimmät verenpaineet", patientId: p2, today, language: lang, ehr });
    expect(r.facts).toHaveLength(2);
    expect(r.answer).toMatch(/Viimeisin verenpainetieto: (systolinen 135|diastolinen 91) mmHg/);
    expect(r.answer).toMatch(/Samalta ajalta on lisäksi (diastolinen 91|systolinen 135) mmHg/);
    expect(r.answer).toMatch(/erillisiä mittausresursseja, joita ei ole yhdistetty pariksi/);
    expect(r.answer).not.toMatch(/135\/91|91\/135/);
    expect(r.answer).not.toMatch(/Aiemmat/); // samanaikaista ei esitetä aiempana
  });

  it("lääkitys: vanha MedicationRequest ei kerro nykyisestä lääkityksestä", async () => {
    const { ehr, idOf } = setup();
    const r = await runAsk({ question: "Mitä lääkitystietoja löytyy?", patientId: idOf("Patient", "demo-patient-1"), today, language: lang, ehr });
    expect(r.facts.find((f) => f.kind === "medication-request")!.flags.join(" ")).toMatch(/yli vuoden vanha/);
    expect(r.answer).toMatch(/ajantasaisuutta/);
  });

  it("FHIR-tekstin 'ignore instructions' jää tietosisällöksi", async () => {
    const { ehr, idOf, fake } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    const r = await runAsk({ question: "Näytä viimeisin kuvantamislausunto", patientId: p1, today, language: lang, ehr });
    const report = r.facts.find((f) => f.kind === "diagnostic-report")!;
    expect(report.attachedText).toMatch(/Ignore all previous instructions/);
    expect(r.plan!.intent).toBe("imaging-report");
    // Kaikki haut koskivat valittua potilasta eikä mitään kirjoitettu tai haettu ulkopuolelta.
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
    expect(fake.calls.every((c) => c.url.includes(`patient=${p1}`))).toBe(true);
    expect(r.answer).not.toMatch(/Veikko/);
  });

  it("laaja kysymys tuottaa yhteenvedon eikä uutta diagnoosia", async () => {
    const { ehr, idOf } = setup();
    const r = await runAsk({ question: "Mikä potilaan ongelma on?", patientId: idOf("Patient", "demo-patient-1"), today, language: lang, ehr });
    expect(r.plan!.intent).toBe("overview");
    expect(r.answer).toMatch(/Tunnetut ongelmat: Verenpainetauti/);
    expect(r.answer).toMatch(/LDL/);
    expect(r.answer).toMatch(/ei ole uusi diagnoosi/);
  });

  it("epäselvä kysymys tarkennetaan ilman hakuja", async () => {
    const { ehr, idOf, fake } = setup();
    const before = fake.calls.length;
    const r = await runAsk({ question: "Mitä kuuluu?", patientId: idOf("Patient", "demo-patient-1"), today, language: lang, ehr });
    expect(r.state).toBe("clarify");
    expect(fake.calls.length).toBe(before);
  });

  it("mallipalvelu puuttuu: selkeä tila, ei keksittyä vastausta", async () => {
    const { ehr, idOf } = setup();
    const r = await runAsk({ question: "Näytä verenpaineet", patientId: idOf("Patient", "demo-patient-1"), today, language: new UnavailableLanguageAdapter("Jev", "ei käytössä"), ehr });
    expect(r.state).toBe("service-unavailable");
    expect(r.facts).toEqual([]);
  });

  it("mallin keksimä luku korvataan faktoista kootulla vastauksella", async () => {
    const { ehr, idOf } = setup();
    const lying: ClinicalLanguageAdapter = { ...lang, name: "testimalli", kind: "model", description: "", interpretQuestion: lang.interpretQuestion, structureTranscript: lang.structureTranscript, answer: async () => "Viimeisin verenpaine 120/80 mmHg." };
    const r = await runAsk({ question: "Näytä viimeisimmät verenpaineet", patientId: idOf("Patient", "demo-patient-1"), today, language: lying, ehr });
    expect(r.answerSource).toBe("deterministic-fallback");
    expect(r.answer).toMatch(/138\/88/);
  });

  it("mallin yritys vaihtaa potilasta tai lisätä URL hylätään skeemassa", async () => {
    const { ehr, idOf, fake } = setup();
    const evil: ClinicalLanguageAdapter = { ...lang, name: "testimalli", kind: "model", description: "", answer: lang.answer, structureTranscript: lang.structureTranscript, interpretQuestion: async () => ({ intent: "blood-pressure", resourceTypes: [], concepts: [], timeRange: null, scope: "patient", clarificationQuestion: null, rationale: "", patientId: "999", url: "http://evil" }) };
    const before = fake.calls.length;
    const r = await runAsk({ question: "x", patientId: idOf("Patient", "demo-patient-1"), today, language: evil, ehr });
    expect(r.state).toBe("error");
    expect(fake.calls.length).toBe(before);
  });

  it("numbersGrounded tunnistaa lähteettömät luvut", () => {
    const facts = [{ kind: "x", label: "", text: "138/88 mmHg", date: "2026-10-01", dateLabel: "", numbers: [138, 88], flags: [], source: { resourceType: "Observation", id: "5", fields: [] } }];
    expect(numbersGrounded("138/88 mmHg (1.10.2026) [Observation/5]", facts).ok).toBe(true);
    expect(numbersGrounded("140/90", facts).ok).toBe(false);
  });
});
