import { describe, expect, it, vi } from "vitest";
import { parseWithRepair } from "../lib/clinical/language-adapter";
import { mockInterpretQuestion } from "../lib/clinical/mock-language";
import { InfoNeedSchema, StructuringOutputSchema } from "../lib/clinical/schemas";

const valid = { intent: "allergies", resourceTypes: ["AllergyIntolerance"], concepts: [], timeRange: null, scope: "patient", clarificationQuestion: null, rationale: "x" };

describe("skeemavalidointi ja korjausyritys", () => {
  it("hyväksyy kelvollisen vastauksen (myös JSON-merkkijonona)", async () => {
    expect((await parseWithRepair(valid, InfoNeedSchema)).ok).toBe(true);
    expect((await parseWithRepair(JSON.stringify(valid), InfoNeedSchema)).ok).toBe(true);
  });

  it("rikkinäinen JSON hylätään ilman korjausta", async () => {
    const r = await parseWithRepair("{intent: oops", InfoNeedSchema);
    expect(r.ok).toBe(false);
  });

  it("tekee enintään rajatun määrän korjausyrityksiä", async () => {
    const repair = vi.fn(async () => ({ ...valid, intent: "nope" }));
    const r = await parseWithRepair({ ...valid, intent: "bad" }, InfoNeedSchema, repair, 1);
    expect(r.ok).toBe(false);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("onnistunut korjaus hyväksytään", async () => {
    const r = await parseWithRepair({ ...valid, extra: 1 }, InfoNeedSchema, async () => valid, 1);
    expect(r.ok && r.attempts).toBe(2);
  });

  it("rakenteistusskeema vaatii lähdeviitteen ja hylkää tuntemattomat kentät", () => {
    const out = { note: { reason: "", history: "", findings: "", assessment: "", plan: "" }, proposals: [] };
    expect(StructuringOutputSchema.safeParse(out).success).toBe(true);
    expect(StructuringOutputSchema.safeParse({ ...out, bundle: {} }).success).toBe(false);
    const prop = { proposalId: "p1", type: "bp", value: { text: "x" }, certainty: "suora", issues: [], subject: "potilas", negation: false, temporality: null, codingCandidate: null, targetResourceType: "Observation" };
    expect(StructuringOutputSchema.safeParse({ ...out, proposals: [prop] }).success).toBe(false); // source puuttuu
  });

  it("mock-tulkinta tuottaa skeemaan sopivan tiedontarpeen esimerkkikysymyksille", () => {
    const qs: [string, string][] = [
      ["Näytä viimeisimmät verenpaineet", "blood-pressure"],
      ["Mitä lääkitystietoja löytyy?", "medications"],
      ["Näytä viimeisin kuvantamislausunto", "imaging-report"],
      ["Mitä keskeisiä ongelmia ja viimeaikaisia muutoksia potilaan tiedoissa näkyy?", "overview"],
      ["Mikä potilaan ongelma on?", "overview"],
      ["Millaisia verikokeita on otettu?", "laboratory"],
      ["Näytä viimeisin verikoe", "laboratory"],
      ["Kerro säästä", "unknown"],
    ];
    for (const [q, intent] of qs) {
      const n = mockInterpretQuestion(q, "2026-10-07");
      expect(InfoNeedSchema.safeParse(n).success).toBe(true);
      expect(n.intent).toBe(intent);
    }
    expect(mockInterpretQuestion("Kerro säästä", "2026-10-07").clarificationQuestion).toBeTruthy();
  });
});
