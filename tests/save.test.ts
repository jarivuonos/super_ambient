import { describe, expect, it } from "vitest";
import { mockStructure } from "../lib/clinical/mock-structurer";
import { parsePastedTranscript } from "../lib/clinical/transcript";
import { approveNote, approveProposal, finalizeStructuring } from "../lib/workflow/review";
import { executeSave, prepareSave, type SaveRequest } from "../lib/workflow/save";
import { setup } from "./helpers";

const t = parsePastedTranscript("Lääkäri: RR 148/92, syke 78. Epäilen appendisiittia.");
const fin = finalizeStructuring(mockStructure(t), t);

async function ctx() {
  const s = setup();
  const caps = await s.ehr.checkCapabilities();
  const patientId = s.idOf("Patient", "demo-patient-1");
  const encounterId = s.idOf("Encounter", "demo-enc-1b");
  const req: SaveRequest = {
    patientId,
    encounterId,
    transcript: t,
    note: approveNote({ draft: fin.note!, approvedHash: null }),
    proposals: fin.proposals.filter((p) => p.targetResourceType).map(approveProposal),
    createdAt: "2026-10-07T10:00:00.000Z",
  };
  req.expectedSnapshot = prepareSave(req).snapshot;
  return { ...s, caps: caps.ok ? caps.summary : null, req };
}

describe("tallennus ja takaisinluku", () => {
  it("tallennus onnistuu ja takaisinluku täsmää", async () => {
    const { ehr, fake, caps, req } = await ctx();
    const before = fake.all("Observation").length;
    const out = await executeSave(ehr, req, caps, { validate: true });
    expect(out.stage).toBe("accepted");
    expect(out.readback.state).toBe("verified");
    expect(out.entries.map((e) => e.resourceType)).toEqual(["DocumentReference", "Observation", "Observation", "Condition"]);
    expect(fake.all("Observation").length).toBe(before + 2);
    const saved = fake.store.get(out.entries[1].reference!)!;
    expect(saved.subject).toEqual({ reference: `Patient/${req.patientId}` });
    expect(saved.encounter).toEqual({ reference: `Encounter/${req.encounterId}` });
  });

  it("kaksi tallennusta samalla identifierillä ei luo duplikaatteja", async () => {
    const { ehr, fake, caps, req } = await ctx();
    const first = await executeSave(ehr, req, caps, { validate: false });
    const count = fake.store.size;
    const second = await executeSave(ehr, req, caps, { validate: false });
    expect(second.stage).toBe("accepted");
    expect(fake.store.size).toBe(count);
    expect(second.entries.every((e) => e.existing)).toBe(true);
    expect(second.entries.map((e) => e.reference)).toEqual(first.entries.map((e) => e.reference));
  });

  it("muuttunut tilannevedos estää tallennuksen", async () => {
    const { ehr, caps, req } = await ctx();
    const out = await executeSave(ehr, { ...req, expectedSnapshot: "vanha" }, caps, { validate: false });
    expect(out.stage).toBe("blocked");
  });

  it("kontakti, joka ei kuulu potilaalle, estää tallennuksen", async () => {
    const { ehr, caps, req, idOf } = await ctx();
    const other = { ...req, encounterId: idOf("Encounter", "demo-enc-2a") };
    other.expectedSnapshot = prepareSave(other).snapshot;
    const out = await executeSave(ehr, other, caps, { validate: false });
    expect(out.stage).toBe("blocked");
    expect(out.errors.join(" ")).toMatch(/ei kuulu valitulle potilaalle/);
  });

  it("vanhaa ehdotusta ei voi tallentaa uudelle potilaalle", async () => {
    const { ehr, caps, req, idOf } = await ctx();
    // Ehdotukset ja tilannevedos on tehty potilaalle 1; pyyntö yrittää potilasta 2.
    const out = await executeSave(ehr, { ...req, patientId: idOf("Patient", "demo-patient-2") }, caps, { validate: false });
    expect(out.stage).toBe("blocked");
  });

  it("ilman transaction-tukea kirjoitus estetään", async () => {
    const { ehr, fake, req } = await ctx();
    fake.transaction = false;
    const caps = await ehr.checkCapabilities();
    const out = await executeSave(ehr, req, caps.ok ? caps.summary : null, { validate: false });
    expect(out.stage).toBe("blocked");
    expect(out.errors.join(" ")).toMatch(/transaction/);
  });

  it("aikakatkaisun jälkeen tila tarkistetaan identifierillä", async () => {
    const { ehr, fake, caps, req } = await ctx();
    // Palvelin käsittelee pyynnön, mutta vastaus ei tule perille.
    fake.hooks.push((u, init) => {
      if (init.method === "POST" && u.pathname === "/baseR4") {
        fake.handleTransaction(JSON.parse(String(init.body)));
        throw new TypeError("socket hang up");
      }
      return undefined;
    });
    const out = await executeSave(ehr, req, caps, { validate: false });
    expect(out.stage).toBe("accepted");
    expect(out.recoveredByIdentifier).toBe(true);
    expect(out.readback.state).toBe("verified");
  });

  it("palvelimen hylkäys (OperationOutcome) näkyy ilman näennäistä onnistumista", async () => {
    const { ehr, fake, caps, req } = await ctx();
    fake.hooks.push((u, init) =>
      init.method === "POST" && u.pathname === "/baseR4" ? fake.json(422, { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "processing", diagnostics: "Profiilivirhe" }] }) : undefined,
    );
    const out = await executeSave(ehr, req, caps, { validate: false });
    expect(out.stage).toBe("rejected");
    expect(out.errors[0]).toMatch(/Profiilivirhe/);
    expect(out.readback.state).toBe("not-run");
  });

  it("takaisinluvun virhe ei muuta tallennusta epäonnistuneeksi", async () => {
    const { ehr, fake, caps, req } = await ctx();
    let posted = false;
    fake.hooks.push((u, init) => {
      if (init.method === "POST") posted = true;
      else if (posted && /\/(Observation|Condition|DocumentReference)\/\w+$/.test(u.pathname)) return fake.json(503, {});
      return undefined;
    });
    const out = await executeSave(ehr, req, caps, { validate: false });
    expect(out.stage).toBe("accepted");
    expect(out.readback.state).toBe("failed");
  });

  it("tallennus vain demopotilaalle", async () => {
    const { ehr, fake, caps, req } = await ctx();
    const p = fake.store.get(`Patient/${req.patientId}`)!;
    fake.store.set(`Patient/${req.patientId}`, { ...p, meta: {} });
    const out = await executeSave(ehr, req, caps, { validate: false });
    expect(out.stage).toBe("blocked");
  });
});
