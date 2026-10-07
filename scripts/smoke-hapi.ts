// Erillinen, käsin käynnistettävä integraatiotesti julkista HAPI-palvelinta vasten.
// KIRJOITTAA palvelimelle vain sovelluksen omaa synteettistä aineistoa.
// Käynnistys: SMOKE_HAPI=1 bun run smoke:hapi

import { runAsk } from "../lib/clinical/ask";
import { MockLanguageAdapter } from "../lib/clinical/language-adapter";
import { mockStructure } from "../lib/clinical/mock-structurer";
import { parsePastedTranscript, SAMPLE_TRANSCRIPT } from "../lib/clinical/transcript";
import { buildFixtureBundle } from "../lib/fhir/fixtures";
import { HapiR4Adapter } from "../lib/fhir/hapi-adapter";
import { DEMO_IDENTIFIER_SYSTEM } from "../lib/fhir/search-builders";
import { approveNote, approveProposal, finalizeStructuring } from "../lib/workflow/review";
import { executeSave, prepareSave, type SaveRequest } from "../lib/workflow/save";

if (process.env.SMOKE_HAPI !== "1") {
  console.error("Tämä testi kirjoittaa julkiseen HAPI-palvelimeen. Käynnistä: SMOKE_HAPI=1 bun run smoke:hapi");
  process.exit(2);
}

const base = process.env.FHIR_BASE_URL ?? "https://hapi.fhir.org/baseR4";
const ehr = new HapiR4Adapter({ baseUrl: base, timeoutMs: 60000 });
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

const caps = await ehr.checkCapabilities();
check(caps.ok, `CapabilityStatement (${base})`);
if (!caps.ok) process.exit(1);
check(caps.summary.transaction, "transaction tuettu");

const seed = await ehr.transaction(buildFixtureBundle().bundle);
check(seed.state === "accepted", `harjoitusaineisto: ${seed.state}${seed.state === "accepted" ? ` (${seed.entries.filter((e) => !e.existing).length} uutta, ${seed.entries.filter((e) => e.existing).length} olemassa)` : ` – ${"error" in seed ? seed.error.message : ""}`}`);

const findId = async (type: string, key: string) => (await ehr.findByIdentifier(type, DEMO_IDENTIFIER_SYSTEM, key)).resources[0]?.id ?? "";
const p1 = await findId("Patient", "demo-patient-1");
const p2 = await findId("Patient", "demo-patient-2");
const e1 = await findId("Encounter", "demo-enc-1b");
check(!!p1 && !!p2 && !!e1, `demopotilaat ja kontakti löytyvät identifierillä (Patient/${p1}, Patient/${p2}, Encounter/${e1})`);

const demo = await ehr.searchPatients("Demolainen", true);
check(demo.resources.some((p) => p.id === p1), `nimihaku demotunnisteella (${demo.state}, ${demo.resources.length} osumaa)`);
const encs = await ehr.searchEncounters(p1);
check(encs.resources.some((e) => e.id === e1), `kontaktihaku (${encs.resources.length})`);

const lang = new MockLanguageAdapter();
const today = new Date().toISOString().slice(0, 10);
const bp = await runAsk({ question: "Näytä viimeisimmät verenpaineet", patientId: p1, today, language: lang, ehr });
check(bp.state === "ok" && bp.facts[0]?.text === "138/88 mmHg", `verenpaineet: ${bp.answer.split("\n")[0]}`);
const bp2 = await runAsk({ question: "Näytä viimeisimmät verenpaineet", patientId: p2, today, language: lang, ehr });
check(bp2.state === "empty" && bp2.facts.length === 0, `potilas 2 ilman verenpaineita: ${bp2.state}`);
for (const q of ["Mitä lääkitystietoja löytyy?", "Näytä viimeisin kuvantamislausunto", "Mitä keskeisiä ongelmia ja viimeaikaisia muutoksia potilaan tiedoissa näkyy?"]) {
  const r = await runAsk({ question: q, patientId: p1, today, language: lang, ehr });
  check(r.state === "ok" || r.state === "partial", `${q} → ${r.state}, ${r.facts.length} faktaa`);
}

const t = parsePastedTranscript(SAMPLE_TRANSCRIPT, "esimerkki");
const fin = finalizeStructuring(mockStructure(t), t);
const req: SaveRequest = {
  patientId: p1,
  encounterId: e1,
  transcript: t,
  note: approveNote({ draft: fin.note!, approvedHash: null }),
  proposals: fin.proposals.filter((p) => p.targetResourceType).map(approveProposal),
  createdAt: new Date().toISOString(),
};
req.expectedSnapshot = prepareSave(req).snapshot;
const first = await executeSave(ehr, req, caps.summary, { validate: true });
check(first.stage === "accepted", `tallennus: ${first.message} ${first.errors.join("; ")}`);
check(first.readback.state === "verified", `takaisinluku: ${first.readback.state} ${first.readback.details.filter((d) => !d.ok).map((d) => d.problems.join(",")).join(" ")}`);
for (const e of first.entries) console.log(`     ${e.key}: ${e.reference} (${e.status})`);
const invalid = (first.validation ?? []).filter((v) => !v.result.ok);
check(invalid.length === 0, `$validate (${(first.validation ?? []).length} resurssia, ${invalid.length} virheellistä)`);

const second = await executeSave(ehr, req, caps.summary, { validate: false });
check(second.stage === "accepted" && second.entries.every((e) => e.existing), "toinen tallennus samalla identifierillä: ei duplikaatteja");
check(JSON.stringify(second.entries.map((e) => e.reference)) === JSON.stringify(first.entries.map((e) => e.reference)), "samat resurssiviitteet");

console.log(failures ? `\n${failures} tarkistusta epäonnistui.` : "\nKaikki tarkistukset onnistuivat.");
process.exit(failures ? 1 : 0);
