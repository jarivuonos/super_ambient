import { describe, expect, it } from "vitest";
import { reportFacts } from "../lib/clinical/facts";
import { mockAnswer, mockInterpretQuestion } from "../lib/clinical/mock-language";
import type { Resource } from "../lib/fhir/types";

const need = mockInterpretQuestion("Näytä viimeisin kuvantamislausunto", "2026-10-15");

const report = (id: string, cat: string, text: string, date: string): Resource =>
  ({ resourceType: "DiagnosticReport", id, status: "final", category: [{ coding: [{ code: cat }] }], code: { text }, effectiveDateTime: date }) as Resource;
const doc = (id: string, type: string, date: string): Resource => ({ resourceType: "DocumentReference", id, status: "current", type: { text: type }, date }) as Resource;

const answer = (rs: Resource[]) => mockAnswer(need, reportFacts(rs), []);

describe("kuvantamislausuntokysymyksen vastaus", () => {
  it("tulkitsee kysymyksen kuvantamislausunnoksi", () => {
    expect(need.intent).toBe("imaging-report");
  });

  it("ei esitä laboratoriolausuntoa kuvantamislausuntona, vaan kertoo ettei kuvantamista löytynyt", () => {
    const a = answer([report("lab1", "LAB", "Cholesterol, total", "2019-05-28T15:59:00Z"), doc("d1", "Progress Notes", "2021-01-29T20:27:00Z")]);
    expect(a).toContain("Kuvantamislausuntoa ei löytynyt");
    expect(a).toContain("DiagnosticReport/lab1");
    expect(a).not.toContain("Viimeisin kuvantamiseen viittaava");
  });

  it("tunnistaa kuvantamista tarkoittavan asiakirjan (Epicin 'Diagnostic imaging study') ja kertoo sen olevan viite", () => {
    const a = answer([report("lab1", "LAB", "Cholesterol, total", "2019-05-28T15:59:00Z"), doc("img1", "Diagnostic imaging study", "2019-05-28T15:29:00Z")]);
    expect(a).toContain("Viimeisin kuvantamiseen viittaava asiakirja: Diagnostic imaging study");
    expect(a).toContain("DocumentReference/img1");
    expect(a).toContain("asiakirjaviite");
    expect(a).not.toContain("Cholesterol");
  });

  it("valitsee uusimman kuvantamiseen viittaavan, vaikka lausunto ja asiakirja ovat eri tyyppiä", () => {
    const a = answer([report("old", "RAD", "Röntgen thorax", "2020-01-01T10:00:00Z"), doc("new", "Radiology report", "2022-03-03T10:00:00Z"), report("lab", "LAB", "CRP", "2025-01-01T10:00:00Z")]);
    expect(a).toContain("DocumentReference/new");
    expect(a).not.toContain("DiagnosticReport/old");
    expect(a).not.toContain("DiagnosticReport/lab");
  });

  it("sanarajat: 'Doctor' tai 'Contact' ei ole kuvantamista", () => {
    const a = answer([doc("n1", "Doctor's note", "2024-01-01T00:00:00Z"), doc("n2", "Contact summary", "2024-02-01T00:00:00Z")]);
    expect(a).toContain("Tästä hausta ei löytynyt kuvantamislausuntoja");
  });

  it("ilman lausuntoja ja asiakirjoja vastaus kertoo ettei tietoa löytynyt", () => {
    expect(answer([])).toContain("Tästä hausta ei löytynyt kuvantamislausuntoja");
  });
});
