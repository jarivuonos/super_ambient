import { describe, expect, it } from "vitest";
import { mockStructure } from "../lib/clinical/mock-structurer";
import { parsePastedTranscript, SAMPLE_TRANSCRIPT } from "../lib/clinical/transcript";
import { finalizeStructuring } from "../lib/workflow/review";

function structure(text: string) {
  const t = parsePastedTranscript(text);
  const r = finalizeStructuring(mockStructure(t), t);
  expect(r.ok).toBe(true);
  expect(r.warnings).toEqual([]); // kaikki lähdeviitteet täsmäävät litteraattiin
  return { t, ...r };
}

describe("litteraatti → ehdotukset (mock-rakenteistaja)", () => {
  it("RR 148/92, syke 78, lämpö 37,4 → kolme mittausehdotusta", () => {
    const { proposals } = structure("Lääkäri: RR 148/92, syke 78, lämpö 37,4");
    const bp = proposals.find((p) => p.type === "bp")!;
    expect(bp.value.bp).toEqual({ systolic: 148, diastolic: 92 });
    expect(bp.targetResourceType).toBe("Observation");
    expect(bp.source.quote).toBe("148/92");
    expect(proposals.find((p) => p.type === "heart-rate")!.value.quantity).toEqual({ value: 78, unit: "/min" });
    expect(proposals.find((p) => p.type === "temperature")!.value.quantity).toEqual({ value: 37.4, unit: "Cel" });
    expect(proposals.every((p) => p.reviewStatus === "tarkistamatta")).toBe(true);
  });

  it("Ei kuumetta. Epäilen appendisiittia. → ei lämpöarvoa, epäily säilyy epävarmana", () => {
    const { proposals } = structure("Lääkäri: Ei kuumetta. Epäilen appendisiittia.");
    expect(proposals.some((p) => p.type === "temperature")).toBe(false);
    const fever = proposals.find((p) => p.type === "symptom")!;
    expect(fever.negation).toBe(true);
    expect(fever.targetResourceType).toBeNull();
    const cond = proposals.find((p) => p.type === "condition")!;
    expect(cond.value.verificationStatus).toBe("provisional");
    expect(cond.codingCandidate?.code).toBe("74400008");
    expect(cond.targetResourceType).toBe("Condition");
  });

  it("kaksi verenpainetta lähteineen, aikaa ei keksitä", () => {
    const { proposals } = structure("Lääkäri: Verenpaine oli ensin 160/100, uusintamittauksessa 145/90");
    const bps = proposals.filter((p) => p.type === "bp");
    expect(bps.map((p) => p.value.bp)).toEqual([
      { systolic: 160, diastolic: 100 },
      { systolic: 145, diastolic: 90 },
    ]);
    expect(bps.map((p) => p.source.quote)).toEqual(["160/100", "145/90"]);
    expect(bps[0].temporality).toMatch(/ensimmäinen/);
    expect(bps[1].temporality).toMatch(/uusinta/);
    expect(bps[0].issues.join(" ")).toMatch(/aikaa ei lisätä/);
  });

  it("isän diabetes ei ole potilaan diagnoosi", () => {
    for (const text of ["Potilas: Isälläni on diabetes.", "Lääkäri: Keskustelimme potilaan isän diabeteksesta."]) {
      const { proposals } = structure(text);
      expect(proposals.some((p) => p.type === "condition")).toBe(false);
      const fh = proposals.filter((p) => p.type === "family-history");
      expect(fh.length).toBe(1);
      expect(fh[0].subject).toBe("läheinen");
      expect(fh[0].targetResourceType).toBeNull();
    }
  });

  it("kysymys ei ole todettu tieto eikä mainitsematonta muuteta kielteiseksi", () => {
    const { proposals } = structure("Lääkäri: Onko ollut kuumetta?");
    expect(proposals).toEqual([]);
  });

  it("ristiriita: 'ei kuumetta' ja kuumetasoinen lämpö", () => {
    const { proposals } = structure("Potilas: Ei kuumetta.\nHoitaja: Lämpö 38,4");
    expect(proposals.find((p) => p.type === "temperature")!.certainty).toBe("ristiriitainen");
  });

  it("epätavallinen arvo merkitään eikä sitä tallenneta havaintona", () => {
    const { proposals } = structure("Lääkäri: verenpaine 80/120");
    const bp = proposals.find((p) => p.type === "bp")!;
    expect(bp.certainty).toBe("ristiriitainen");
    expect(bp.targetResourceType).toBeNull();
  });

  it("esimerkkikeskustelu tuottaa luonnoksen, joka erottelee lähteet", () => {
    const { note, proposals } = structure(SAMPLE_TRANSCRIPT);
    expect(note!.reason).toMatch(/vatsakipua/);
    expect(note!.history).toMatch(/Potilas kertoo/);
    expect(note!.findings).toMatch(/Mitattu: Verenpaine/);
    expect(note!.assessment).toMatch(/Epäilen appendisiittia/);
    expect(note!.plan).toMatch(/päivystykseen/);
    expect(proposals.find((p) => p.type === "medication-mention")!.targetResourceType).toBeNull();
    expect(proposals.find((p) => p.type === "allergy-mention")!.targetResourceType).toBeNull();
    // Mainitsematonta ei tehdä kielteiseksi: ei yskä-ehdotuksia
    expect(proposals.some((p) => /yskä/i.test(p.value.text))).toBe(false);
  });

  it("puhujaroolit vain käyttäjän merkinnöistä; muuten tuntematon", () => {
    const t = parsePastedTranscript("Vatsaan sattuu.\nEpäilen gastroenteriittiä.");
    expect(t.speakerSource).toBe("ei tiedossa");
    expect(t.segments.every((s) => s.speaker === "tuntematon")).toBe(true);
    const r = finalizeStructuring(mockStructure(t), t);
    expect(r.proposals.find((p) => p.type === "condition")!.certainty).toBe("tulkinnanvarainen");
  });
});

describe("mallivastauksen tarkistus", () => {
  const t = parsePastedTranscript("Lääkäri: Epäilen migreeniä. RR 150/95");
  const base = mockStructure(t);

  it("väärä lainaus tai litteraattiversio hylätään", () => {
    const bad = structuredClone(base);
    bad.proposals[0].source.quote = "keksitty";
    bad.proposals[1].source.transcriptVersion = "deadbeefdeadbeef";
    const r = finalizeStructuring(bad, t);
    expect(r.proposals.length).toBe(base.proposals.length - 2);
    expect(r.warnings.length).toBe(2);
  });

  it("tuntematon koodi poistetaan ja 'confirmed' muutetaan varmistamattomaksi", () => {
    const m = structuredClone(base);
    const c = m.proposals.find((p) => p.type === "condition")!;
    c.codingCandidate = { system: "http://snomed.info/sct", code: "999999", display: "Keksitty" };
    c.value.verificationStatus = "confirmed";
    const r = finalizeStructuring(m, t);
    const out = r.proposals.find((p) => p.type === "condition")!;
    expect(out.codingCandidate).toBeNull();
    expect(out.value.verificationStatus).toBe("unconfirmed");
    expect(out.appIssues.length).toBe(2);
  });

  it("malli ei voi ohjata läheisen tietoa tai suunnitelmaa FHIR-resurssiksi", () => {
    const m = structuredClone(base);
    m.proposals[0].subject = "läheinen";
    m.proposals.push({ ...structuredClone(m.proposals[0]), proposalId: "p99", subject: "potilas", type: "plan", targetResourceType: "Condition" });
    const r = finalizeStructuring(m, t);
    expect(r.proposals[0].targetResourceType).toBeNull();
    expect(r.proposals.find((p) => p.proposalId === "p99")!.targetResourceType).toBeNull();
  });

  it("rikkinäinen vastaus ei pääse eteenpäin", () => {
    expect(finalizeStructuring({ note: {}, proposals: "x" }, t).ok).toBe(false);
  });
});
