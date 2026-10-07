/* eslint-disable @typescript-eslint/no-explicit-any -- testeissä FHIR-rakenteiden syvä tarkastelu */
import { describe, expect, it } from "vitest";
import { mockStructure } from "../lib/clinical/mock-structurer";
import { parsePastedTranscript } from "../lib/clinical/transcript";
import { base64ToUtf8, buildSaveBundle, snapshotHash } from "../lib/fhir/resource-builders";
import { SAVED_IDENTIFIER_SYSTEM } from "../lib/fhir/search-builders";
import type { Resource } from "../lib/fhir/types";
import { approveNote, approveProposal, finalizeStructuring } from "../lib/workflow/review";

const t = parsePastedTranscript("Lääkäri: RR 148/92, syke 78, lämpö 37,4. Epäilen appendisiittia. Vatsakipua on ollut eilisestä.");
const fin = finalizeStructuring(mockStructure(t), t);
const approved = fin.proposals.filter((p) => p.targetResourceType).map(approveProposal);
const input = {
  patientId: "pat1",
  encounterId: "enc1",
  transcriptVersion: t.version,
  note: approveNote({ draft: fin.note!, approvedHash: null }).draft,
  proposals: approved,
  createdAt: "2026-10-07T10:00:00.000Z",
};

// Sallitut ylätason kentät (FHIR R4); ei vapaita, standardiin kuulumattomia kenttiä.
const ALLOWED: Record<string, string[]> = {
  Observation: ["resourceType", "meta", "identifier", "status", "category", "code", "subject", "encounter", "component", "valueQuantity", "note"],
  Condition: ["resourceType", "meta", "identifier", "clinicalStatus", "verificationStatus", "category", "code", "subject", "encounter", "note"],
  DocumentReference: ["resourceType", "meta", "identifier", "status", "docStatus", "type", "subject", "date", "description", "content", "context"],
};

describe("FHIR-resurssirakentajat", () => {
  const { bundle, resources, map } = buildSaveBundle(input);
  const byCode = (code: string) => resources.find((r) => (r.code as { coding?: { code?: string }[] })?.coding?.[0]?.code === code) as Resource & Record<string, any>;

  it("verenpaine: paneeli, komponentit, UCUM mm[Hg], potilas- ja kontaktiviite, ei keksittyä aikaa", () => {
    const o = byCode("85354-9");
    expect(o.component[0].code.coding[0].code).toBe("8480-6");
    expect(o.component[0].valueQuantity).toEqual({ value: 148, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" });
    expect(o.component[1].code.coding[0].code).toBe("8462-4");
    expect(o.component[1].valueQuantity.value).toBe(92);
    expect(o.subject).toEqual({ reference: "Patient/pat1" });
    expect(o.encounter).toEqual({ reference: "Encounter/enc1" });
    expect(o.effectiveDateTime).toBeUndefined();
    expect(o.effectivePeriod).toBeUndefined();
    expect(o.category[0].coding[0].code).toBe("vital-signs");
  });

  it("syke /min ja lämpö Cel", () => {
    expect(byCode("8867-4").valueQuantity).toMatchObject({ value: 78, code: "/min" });
    expect(byCode("8310-5").valueQuantity).toMatchObject({ value: 37.4, code: "Cel", system: "http://unitsofmeasure.org" });
  });

  it("diagnoosiepäily: Condition provisional, tarkistettu SNOMED-koodi", () => {
    const c = resources.find((r) => r.resourceType === "Condition" && (r.code as any).coding) as any;
    expect(c.verificationStatus.coding[0]).toEqual({ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "provisional" });
    expect(c.code.coding[0]).toMatchObject({ system: "http://snomed.info/sct", code: "74400008" });
    expect(c.clinicalStatus.coding[0].code).toBe("active");
  });

  it("käyntimerkintä: DocumentReference current/preliminary, teksti liitteenä, subject ja context.encounter", () => {
    const d = resources.find((r) => r.resourceType === "DocumentReference") as any;
    expect(d.status).toBe("current");
    expect(d.docStatus).toBe("preliminary");
    expect(d.subject).toEqual({ reference: "Patient/pat1" });
    expect(d.context.encounter).toEqual([{ reference: "Encounter/enc1" }]);
    expect(d.author).toBeUndefined(); // ei keksittyä Practitioneria
    const text = base64ToUtf8(d.content[0].attachment.data);
    expect(text).toMatch(/Nykytila ja havainnot/);
    expect(text).toMatch(/Epäilen appendisiittia/);
    expect(d.content[0].attachment.contentType).toMatch(/^text\/plain/);
  });

  it("ei standardiin kuulumattomia kenttiä", () => {
    for (const r of resources) {
      for (const k of Object.keys(r)) expect(ALLOWED[r.resourceType]).toContain(k);
    }
  });

  it("transaction-Bundle: conditional create identifierillä ja urn:uuid fullUrl", () => {
    expect(bundle.type).toBe("transaction");
    for (const [i, e] of bundle.entry!.entries()) {
      expect(e.request!.method).toBe("POST");
      expect(e.request!.ifNoneExist).toBe(`identifier=${encodeURIComponent(SAVED_IDENTIFIER_SYSTEM)}|${encodeURIComponent(map[i].identifierValue)}`);
      expect(e.fullUrl).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(e.resource!.identifier![0]).toEqual({ system: SAVED_IDENTIFIER_SYSTEM, value: map[i].identifierValue });
    }
  });

  it("sama tilannevedos → samat tunnisteet; muutos → uudet", () => {
    const again = buildSaveBundle(input);
    expect(again.map.map((m) => m.identifierValue)).toEqual(map.map((m) => m.identifierValue));
    expect(snapshotHash({ ...input, encounterId: "enc2" })).not.toBe(snapshotHash(input));
  });
});
