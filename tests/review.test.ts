import { describe, expect, it } from "vitest";
import { mockStructure } from "../lib/clinical/mock-structurer";
import { parsePastedTranscript } from "../lib/clinical/transcript";
import { approveNote, approveProposal, editNote, editProposal, finalizeStructuring, isApprovalValid, isNoteApproved, isSavable } from "../lib/workflow/review";
import { prepareSave, type SaveRequest } from "../lib/workflow/save";

const t = parsePastedTranscript("Lääkäri: RR 148/92. Epäilen appendisiittia.");
const fin = finalizeStructuring(mockStructure(t), t);
const bp = fin.proposals.find((p) => p.type === "bp")!;
const cond = fin.proposals.find((p) => p.type === "condition")!;

function req(over: Partial<SaveRequest> = {}): SaveRequest {
  return { patientId: "1", encounterId: "2", transcript: t, note: null, proposals: [approveProposal(bp)], createdAt: "2026-10-07T10:00:00.000Z", ...over };
}

describe("hyväksynnän vanheneminen", () => {
  it("tarkistamaton ei ole tallennettavissa", () => {
    expect(isSavable(bp)).toBe(false);
    expect(isSavable(approveProposal(bp))).toBe(true);
  });

  it("muokkaus hyväksynnän jälkeen peruu hyväksynnän", () => {
    const a = approveProposal(bp);
    const edited = editProposal(a, { value: { ...a.value, bp: { systolic: 150, diastolic: 92 }, text: "Verenpaine 150/92 mmHg" } });
    expect(edited.reviewStatus).toBe("tarkistamatta");
    expect(isApprovalValid(edited)).toBe(false);
  });

  it("muuttumaton muokkaus säilyttää hyväksynnän", () => {
    const a = approveProposal(bp);
    expect(isApprovalValid(editProposal(a, { value: { ...a.value } }))).toBe(true);
  });

  it("käsin muutettu sisältö hyväksyttynä tilana ei läpäise tarkistusta", () => {
    const a = approveProposal(bp);
    const tampered = { ...a, value: { ...a.value, bp: { systolic: 200, diastolic: 120 } } };
    expect(isApprovalValid(tampered)).toBe(false);
    const r = prepareSave(req({ proposals: [tampered] }));
    expect(r.ok).toBe(false);
  });

  it("käyntimerkinnän muokkaus peruu hyväksynnän", () => {
    const n = approveNote({ draft: fin.note!, approvedHash: null });
    expect(isNoteApproved(n)).toBe(true);
    expect(isNoteApproved(editNote(n, { plan: "uusi suunnitelma" }))).toBe(false);
  });

  it("litteraatin muutos vanhentaa siihen perustuvat ehdotukset", () => {
    const t2 = parsePastedTranscript("Lääkäri: RR 148/93. Epäilen appendisiittia.");
    const r = prepareSave(req({ transcript: t2 }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/eri litteraattiversiota/);
  });

  it("väärennetty litteraattiversio hylätään", () => {
    const r = prepareSave(req({ transcript: { ...t, segments: [{ ...t.segments[0], text: t.segments[0].text + " lisäys" }] } }));
    expect(r.ok).toBe(false);
  });

  it("tallennus sisältää vain hyväksytyt ja sallitut kohteet", () => {
    const ok = prepareSave(req({ proposals: [approveProposal(bp), approveProposal(cond)] }));
    expect(ok.ok).toBe(true);
    expect(ok.resources!.map((r) => r.resourceType)).toEqual(["Observation", "Condition"]);
    const unapproved = prepareSave(req({ proposals: [bp] }));
    expect(unapproved.ok).toBe(false);
    const nothing = prepareSave(req({ proposals: [] }));
    expect(nothing.ok).toBe(false);
  });

  it("hyväksymätöntä käyntimerkintää ei tallenneta", () => {
    const r = prepareSave(req({ proposals: [], note: { draft: fin.note!, approvedHash: "x" } }));
    expect(r.ok).toBe(false);
    const ok = prepareSave(req({ proposals: [], note: approveNote({ draft: fin.note!, approvedHash: null }) }));
    expect(ok.ok).toBe(true);
    expect(ok.resources![0].resourceType).toBe("DocumentReference");
  });
});

describe("muokkaus ja FHIR-kohde", () => {
  it("virheellinen arvo poistaa Observation-kohteen, jotta näkymä vastaa palvelinta", () => {
    const a = approveProposal(bp);
    const bad = editProposal(a, { value: { ...a.value, bp: { systolic: 80, diastolic: 120 } } });
    expect(bad.targetResourceType).toBeNull();
    expect(isSavable(approveProposal(bad))).toBe(false);
    const fixed = editProposal(bad, { value: { ...bad.value, bp: { systolic: 140, diastolic: 90 } } });
    expect(fixed.targetResourceType).toBe("Observation");
  });
});
