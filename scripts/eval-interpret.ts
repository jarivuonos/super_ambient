// Kysymystulkinnan arviointi suomenkielisellä joukolla: mock-säännöt vs. Jev.
//
//   bun run eval:interpret                 vain mock (ei verkkoyhteyksiä)
//   bun run eval:interpret -- --jev        lisäksi Jev (TYPESAFE_API_KEY ympäristöstä; ~40 pientä kutsua)
//   bun run eval:interpret -- --jev --limit 5
//
// Skripti ei tulosta avainta eikä koskaan lähetä muuta kuin kysymystekstin. Jev-kutsut ajetaan
// peräkkäin (alin tilaus sallii yhden samanaikaisen pyynnön).

import { daysAgo, type Period } from "../lib/clinical/intents";
import { JevClient, JevError } from "../lib/clinical/jev-client";
import { THRESHOLDS, buildQuestions, toInfoNeed, type InterpretDiagnostics } from "../lib/clinical/jev-interpreter";
import { mockInterpretQuestion } from "../lib/clinical/mock-language";
import type { InfoNeed } from "../lib/clinical/schemas";
import { readJevSettings } from "../lib/jev-settings";
import { CORE_SET, EVAL_SET, accepts, type EvalCase } from "./data/question-eval-set";

const args = process.argv.slice(2);
const useJev = args.includes("--jev");
const limitArg = args.indexOf("--limit");
const cases: EvalCase[] = limitArg >= 0 ? EVAL_SET.slice(0, Number(args[limitArg + 1])) : EVAL_SET;
const TODAY = new Date().toISOString().slice(0, 10);

interface Got {
  intent: string;
  visitOnly: boolean;
  period: Period;
}

function sinceToPeriod(since: string | undefined): Period {
  if (!since) return "none";
  if (since === daysAgo(TODAY, 7)) return "week";
  if (since === daysAgo(TODAY, 30)) return "month";
  if (since === daysAgo(TODAY, 365)) return "year";
  return "none";
}
const gotOf = (n: InfoNeed): Got => ({ intent: n.intent === "unknown" ? "none" : n.intent, visitOnly: n.scope === "encounter", period: sinceToPeriod(n.timeRange?.since ?? undefined) });

interface Row {
  c: EvalCase;
  got?: Got;
  error?: string;
  ms?: number;
  diag?: InterpretDiagnostics;
}

const coreMembers = new Set<EvalCase>(CORE_SET);
const expectedLabel = (c: EvalCase) => (c.alsoAccept?.length ? `${c.intent} (myös ${c.alsoAccept.join("/")})` : c.intent);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)} %` : "–");

function score(name: string, rows: Row[]) {
  const ok = rows.filter((r) => r.got);
  const intentOk = ok.filter((r) => accepts(r.c, r.got!.intent)).length;
  const scopeOk = ok.filter((r) => r.got!.visitOnly === (r.c.visitOnly ?? false)).length;
  const periodOk = ok.filter((r) => r.got!.period === (r.c.period ?? "none")).length;
  const allOk = ok.filter((r) => accepts(r.c, r.got!.intent) && r.got!.visitOnly === (r.c.visitOnly ?? false) && r.got!.period === (r.c.period ?? "none")).length;
  console.log(`\n=== ${name} (${ok.length}/${rows.length} vastausta${rows.length - ok.length ? `, ${rows.length - ok.length} virhettä` : ""}) ===`);
  console.log(`tiedontarve ${pct(intentOk, ok.length)} · kontaktirajaus ${pct(scopeOk, ok.length)} · aikaväli ${pct(periodOk, ok.length)} · kaikki oikein ${pct(allOk, ok.length)}`);
  for (const [label, member] of [["perusjoukko", true], ["vaikeampi joukko", false]] as const) {
    const g = ok.filter((r) => coreMembers.has(r.c) === member);
    if (!g.length) continue;
    const all = g.filter((r) => accepts(r.c, r.got!.intent) && r.got!.visitOnly === (r.c.visitOnly ?? false) && r.got!.period === (r.c.period ?? "none")).length;
    console.log(`  ${label}: tiedontarve ${g.filter((r) => accepts(r.c, r.got!.intent)).length}/${g.length} · kaikki oikein ${all}/${g.length}`);
  }
  const tags = [...new Set(rows.map((r) => r.c.tag ?? "-"))];
  console.log("tiedontarve per tyyppi: " + tags.map((t) => {
    const g = ok.filter((r) => (r.c.tag ?? "-") === t);
    return `${t} ${g.filter((r) => accepts(r.c, r.got!.intent)).length}/${g.length}`;
  }).join(" · "));
  const wrongKnown = ok.filter((r) => !accepts(r.c, r.got!.intent) && r.got!.intent !== "none").length;
  const needlessClarify = ok.filter((r) => r.got!.intent === "none" && !accepts(r.c, "none")).length;
  console.log(`väärä haku (tulkittu eri tiedontarpeeksi): ${wrongKnown} · tarpeeton tarkennuspyyntö: ${needlessClarify}`);
  for (const r of ok) {
    const g = r.got!;
    const bad: string[] = [];
    if (!accepts(r.c, g.intent)) bad.push(`tarve ${expectedLabel(r.c)} → ${g.intent}`);
    if (g.visitOnly !== (r.c.visitOnly ?? false)) bad.push(`kontakti ${r.c.visitOnly ?? false} → ${g.visitOnly}`);
    if (g.period !== (r.c.period ?? "none")) bad.push(`aika ${r.c.period ?? "none"} → ${g.period}`);
    if (bad.length) console.log(`  ✗ "${r.c.q}"  [${bad.join("; ")}]${r.diag ? `  (p=${r.diag.intent.probability.toFixed(2)}, conf=${r.diag.intent.confidence.toFixed(2)})` : ""}`);
  }
  for (const r of rows.filter((x) => x.error)) console.log(`  ! "${r.c.q}": ${r.error}`);
}

// --- mock ---
const mockRows: Row[] = cases.map((c) => ({ c, got: gotOf(mockInterpretQuestion(c.q, TODAY)) }));
score("MOCK (sääntöpohjainen)", mockRows);

if (!useJev) {
  console.log("\nJev-ajo ohitettu. Aja `bun run eval:interpret -- --jev`, kun TYPESAFE_API_KEY on asetettu.");
  process.exit(0);
}

// --- Jev ---
const settings = readJevSettings(process.env);
if (!settings.ok) {
  console.error(`\nJev-ajoa ei voi tehdä: ${settings.reason}`);
  process.exit(1);
}
const client = new JevClient({ ...settings.settings });
const jevRows: Row[] = [];
let authFailures = 0;
for (const c of cases) {
  const t0 = Date.now();
  try {
    const response = await client.ask(c.q, buildQuestions());
    const { need, diagnostics } = toInfoNeed(response, TODAY);
    jevRows.push({ c, got: gotOf(need), ms: Date.now() - t0, diag: diagnostics });
  } catch (e) {
    const err = e instanceof JevError ? e : new JevError("network");
    jevRows.push({ c, error: err.message, ms: Date.now() - t0 });
    if (err.kind === "auth" && ++authFailures >= 2) {
      console.error("\nAvain hylätty kahdesti; keskeytetään.");
      break;
    }
  }
}
score(`JEV (${client.model})`, jevRows);

const ms = jevRows.map((r) => r.ms ?? 0).sort((a, b) => a - b);
if (ms.length) console.log(`viive: mediaani ${ms[Math.floor(ms.length / 2)]} ms · suurin ${ms[ms.length - 1]} ms`);
const tokens = jevRows.reduce((s, r) => s + (r.diag?.usage?.input_tokens ?? 0) + (r.diag?.usage?.output_tokens ?? 0), 0);
console.log(`tokeneita yhteensä: ${tokens}`);

// Kynnysarvojen pyyhkäisy tallennetuista todennäköisyyksistä (ei lisäkutsuja).
const withDiag = jevRows.filter((r) => r.diag);
if (withDiag.length) {
  console.log(`\nKynnysarvon vaikutus (nykyinen ${THRESHOLDS.intentProbability}, confidence-raja ${THRESHOLDS.intentConfidence}):`);
  console.log("kynnys | oikein haettu | väärä haku | tarpeeton tarkennus | oikea tarkennus");
  for (const t of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    let right = 0, wrong = 0, needless = 0, rightClarify = 0;
    for (const r of withDiag) {
      const d = r.diag!.intent;
      const pred = d.choice === "none" || d.probability < t || d.confidence < THRESHOLDS.intentConfidence ? "none" : d.choice;
      if (accepts(r.c, pred)) {
        if (pred === "none") rightClarify++;
        else right++;
      } else if (pred === "none") needless++;
      else wrong++;
    }
    console.log(`${t.toFixed(1)}    | ${String(right).padStart(13)} | ${String(wrong).padStart(10)} | ${String(needless).padStart(19)} | ${String(rightClarify).padStart(15)}`);
  }
  console.log("Tavoite: väärä haku mahdollisimman pieni; tarpeeton tarkennus on turvallisempi virhe kuin väärä haku.");
}
