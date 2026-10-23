// Gemini-litteroinnin koeajo synteettisellä äänellä. EI kuulu sovellukseen; ajaa omistaja, kuten Jev-arvioinnit.
//
//   bun run eval:transcribe -- --list                       Näyttää esimerkkikeskustelut, joita voi lukea ääneen
//   bun run eval:transcribe                                 Kuivaajo: näyttää tiedostot ja viitteet, EI lähetä mitään
//   bun run eval:transcribe -- --send [--mode plain|diarize|both] [--lang fi-FI] [--timestamps]
//                                      [--only id1,id2] [--dir local/asr/audio] [--model gemini-3.5-transcribe] [--solo] [--retries 3] [--engine transcribe|prompt] [--digits] [--thinking low]
//
// --thinking: (vain kehotetila) `thinking_level`; gemini-3.8-flashin oletus on medium, ja alempi taso lyhentää odotusta (ks. ajattelutokenit tulosrivillä).
// --digits: (vain kehotetila) pyytää numerot, mittaukset, annokset ja päivämäärät numeroina ("145/90", "5 mg"). Kirjoita viitetiedostoon
//           luvut numeroina, jotta vertailu mittaa juuri tätä; sovelluksen mittausten poiminta ymmärtää vain numerot.
// --engine: oletus johdetaan mallin nimestä. Nimi, jossa on "transcribe", käyttää erillistä litterointimallia (transcription_config);
//           muu malli (esim. gemini-3.8-flash) saa litterointipyynnön tekstikehotteena, ja puhujat pyydetään riveinä "Speaker N:".
// --retries: uusintojen määrä, kun Google vastaa 429/5xx (esim. 503 "high demand"); odotus kasvaa 2, 4, 8 … s (enintään 60 s).
// --solo: kaikki roolit luki yksi ääni. Puhujapisteytys ohitetaan, tila on oletuksena `plain`, ja `--mode both`
//         kertoo lisäksi, montako puhujaa palvelu kuuli (pitäisi olla 1; useampi tarkoittaa yhden äänen jakamista).
//
// Äänitiedostot luetaan kansiosta local/asr/audio (git ei seuraa sitä). Nimeä tiedosto esimerkin tunnisteella
// (esim. fi-vatsakipu.ogg) tai lisää viereen <nimi>.ref.txt (rivit "Lääkäri: teksti").
// `--send` lähettää äänen Googlen Gemini Files API:in (säilyy siellä enintään 48 h, poistetaan ajon lopussa).
// Käytä vain synteettistä ääntä: ilmaisen tason syötteitä voidaan käyttää Googlen tuotteiden parantamiseen.
// Avain luetaan ympäristömuuttujasta GEMINI_API_KEY (ei koskaan tulosteta).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, basename } from "node:path";
import { SAMPLE_CONVERSATIONS } from "../lib/clinical/sample-conversations";
import { engineFor, GeminiError, GeminiTranscriber, type AsrResult, type Engine, type StageTimings } from "../lib/transcription/gemini-client";
import { formatTimings } from "../lib/transcription/timings";
import { tokenize } from "./asr/metrics";
import { findReference, parseReferenceText, type Reference } from "./asr/references";
import { loadRuns } from "./asr/results";
import { scoreTranscript, type FileScore } from "./asr/score";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

const MIME: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mp3",
  ".m4a": "audio/m4a",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
  ".aac": "audio/aac",
};
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(1)} %`);

if (flag("list")) {
  console.log("Esimerkkikeskustelut, joita voi lukea ääneen (nimeä äänitiedosto tunnisteella, esim. fi-<tunniste>.ogg):\n");
  for (const s of SAMPLE_CONVERSATIONS) {
    const turns = parseReferenceText(s.text);
    const words = turns.reduce((n, t) => n + tokenize(t.text).length, 0);
    const roles = [...new Set(turns.map((t) => t.who))].join(", ");
    console.log(`  ${s.id.padEnd(28)} ${String(words).padStart(4)} sanaa (~${(words / 140).toFixed(1)} min)  roolit: ${roles}\n      ${s.title}`);
  }
  console.log("\nPuhujien erottelun testaus vaatii eri äänet: lue jokaisen roolin vuorot eri henkilö (tai synteettinen ääni).");
  process.exit(0);
}

const dir = opt("dir", "local/asr/audio");
const lang = opt("lang", "fi-FI");
const model = opt("model", "gemini-3.5-transcribe");
const solo = flag("solo");
/** --thinking low|medium|high|minimal (vain kehotetila): mallin ajattelun määrä; ilman valitsinta palvelun oletus. */
const thinking = opt("thinking", "") || undefined;
const engine = opt("engine", engineFor(model)) as Engine;
if (engine !== "transcribe" && engine !== "prompt") {
  console.error("Virheellinen --engine (sallitut: transcribe, prompt).");
  process.exit(1);
}
const mode = opt("mode", solo ? "plain" : "both");
const only = opt("only", "").split(",").filter(Boolean);
if (!["plain", "diarize", "both"].includes(mode)) {
  console.error('Virheellinen --mode (sallitut: plain, diarize, both).');
  process.exit(1);
}

interface Item {
  file: string;
  base: string;
  mime: string;
  bytes: number;
  ref: Reference | null;
}

function collect(): Item[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => MIME[extname(f).toLowerCase()])
    .map((f) => {
      const base = basename(f, extname(f));
      const side = join(dir, `${base}.ref.txt`);
      return { file: join(dir, f), base, mime: MIME[extname(f).toLowerCase()], bytes: statSync(join(dir, f)).size, ref: findReference(base, existsSync(side) ? readFileSync(side, "utf8") : undefined) };
    })
    .filter((it) => !only.length || only.includes(it.base) || only.includes(it.ref?.id ?? ""))
    .sort((a, b) => a.base.localeCompare(b.base));
}

if (flag("digits") && engine !== "prompt") console.log("Huom: --digits ei vaikuta erillisellä litterointimallilla (ei kehotetta); käytä yleismallia, esim. --model gemini-3.8-flash.");
if (engine === "prompt" && flag("timestamps")) console.log("Huom: --timestamps ei vaikuta yleismallilla (sanakohtaisia aikaleimoja ei pyydetä kehotteella).");
const items = collect();
const modes = mode === "both" ? (["plain", "diarize"] as const) : ([mode] as const);

console.log(`Kansio: ${dir} · kieli ${lang} · malli ${model} (${engine === "transcribe" ? "erillinen litterointimalli" : "yleismalli + kehote"}) · tilat: ${modes.join(", ")}${flag("timestamps") ? " · sanakohtaiset aikaleimat" : ""}${solo ? " · SOLO (yksi ääni, puhujapisteytys ohitetaan)" : ""}${flag("digits") && engine === "prompt" ? " · NUMEROT NUMEROINA" : ""}${thinking && engine === "prompt" ? ` · AJATTELU ${thinking}` : ""}`);
if (!items.length) {
  console.log(`\nÄänitiedostoja ei löytynyt. Tallenna ne kansioon ${dir} (${Object.keys(MIME).join(", ")}). Katso --list.`);
  process.exit(0);
}
for (const it of items) {
  const refInfo = it.ref ? `viite: ${it.ref.title} (${it.ref.source}, ${it.ref.turns.length} vuoroa)` : "EI VIITETTÄ (litteroidaan, mutta ei pisteytetä)";
  console.log(`  ${it.base.padEnd(30)} ${(it.bytes / 1024).toFixed(0).padStart(6)} kt  ${it.mime.padEnd(11)} ${refInfo}`);
}

interface Row {
  base: string;
  mode: string;
  ok: boolean;
  seconds: number;
  error?: string;
  score?: FileScore;
  chars?: number;
  words?: number;
  timings?: StageTimings;
}
function printSummary(rows: Row[], modes: readonly string[]) {
  console.log("\n=== YHTEENVETO ===");
  for (const m of modes) {
    const r = rows.filter((x) => x.mode === m);
    const ok = r.filter((x) => x.ok);
    const scored = ok.filter((x) => x.score);
    const sum = (f: (s: FileScore) => number) => scored.reduce((a, x) => a + f(x.score!), 0);
    const refWords = sum((s) => s.wer.refWords);
    const errs = sum((s) => s.wer.substitutions + s.wer.deletions + s.wer.insertions);
    console.log(`\n[${m}] onnistui ${ok.length}/${r.length}, pisteytetty ${scored.length}`);
    if (scored.length) {
      console.log(`  sanavirhe (WER, sanamäärällä painotettu): ${pct(refWords ? errs / refWords : null)}  (${errs} virhettä / ${refWords} sanaa)`);
      const negRef = sum((s) => s.negations.refCount);
      console.log(`  kieltosanat säilyneet: ${sum((s) => s.negations.preserved)}/${negRef} · keksittyjä tai muuttuneita: ${sum((s) => s.negations.spurious)}`);
      const numRef = sum((s) => s.numbers.refCount);
      console.log(`  numerot säilyneet: ${sum((s) => s.numbers.preserved)}/${numRef} · väärin tai ylimääräisiä: ${sum((s) => s.numbers.spurious)}`);
      const refProp = sum((s) => s.agreement.refProposals);
      const missing = sum((s) => s.agreement.missing.length);
      console.log(`  rakenteistus (mock) viitteestä vs. litteraatista: ${refProp - missing}/${refProp} ehdotusta samoin · litteraatista ylimääräisiä kohteellisia (Observation/Condition): ${sum((s) => s.agreement.extraTargets)}`);
      const sp = scored.filter((x) => x.score!.speakers);
      if (solo && m === "diarize") {
        for (const x of ok) {
          const n = x.score?.speakerCount ?? null;
          const share = x.score?.dominantSpeakerShare ?? null;
          console.log(`  ${x.base}: puhujia tunnistettu ${n ?? "–"} (odotus 1)${n !== null && n > 1 ? `, suurimman osuus ${pct(share)} sanoista  ⚠ yksi ääni jaettiin useaksi puhujaksi` : ""}`);
        }
        if (!ok.some((x) => x.score?.speakerCount)) console.log("  Puhujatietoa ei saatu vastauksesta (katso tallennetut raakavastaukset).");
      } else if (sp.length) {
        const paired = sp.reduce((a, x) => a + x.score!.speakers!.pairedWords, 0);
        const acc = sp.reduce((a, x) => a + (x.score!.speakers!.accuracy ?? 0) * x.score!.speakers!.pairedWords, 0);
        console.log(`  puhujien kohdistus (sanatasolla): ${pct(paired ? acc / paired : null)}`);
        for (const x of sp) {
          const s = x.score!.speakers!;
          const warn = s.patientAndRelativeMerged ? "  ⚠ potilas ja läheinen yhdistyivät samaksi puhujaksi" : "";
          const rel = s.relativeAsPatientRate !== null ? ` · läheisen sanoista potilaalle: ${pct(s.relativeAsPatientRate)}` : "";
          console.log(`    ${x.base}: ${pct(s.accuracy)} (${Object.keys(s.mapping).length} puhujaa tunnistettu)${rel}${warn}`);
        }
      } else if (m === "diarize") {
        console.log("  Puhujatietoa ei saatu vastauksesta (katso tallennetut raakavastaukset).");
      }
    }
    for (const x of r.filter((y) => !y.ok)) console.log(`  VIRHE ${x.base}: ${x.error}`);
  }
}

// --rescore <tuloskansio>: pisteyttää tallennetut vastaukset uudelleen nykyisillä viitteillä; ei verkkoa, ei avainta.
const rescoreDir = opt("rescore", "");
if (rescoreDir) {
  const refs = new Map(items.map((it) => [it.base, it.ref]));
  const rescored: Row[] = [];
  for (const run of loadRuns(rescoreDir)) {
    const row: Row = { base: run.file, mode: run.mode, ok: run.result !== null, seconds: run.requestSeconds, error: run.error ?? undefined };
    const ref = refs.get(run.file) ?? null;
    if (run.result && ref) row.score = scoreTranscript(ref, run.result, run.language, { solo });
    rescored.push(row);
  }
  console.log(`\nPISTEYTETÄÄN UUDELLEEN ${rescored.length} tallennettua vastausta kansiosta ${rescoreDir} (ei verkkoa, ei avainta).`);
  printSummary(rescored, [...new Set(rescored.map((r) => r.mode))]);
  process.exit(0);
}

if (!flag("send")) {
  console.log(`\nKuivaajo: mitään ei lähetetty. ${items.length} tiedostoa x ${modes.length} tilaa = ${items.length * modes.length} pyyntöä Googlelle, kun lisäät --send.`);
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("\nGEMINI_API_KEY puuttuu ympäristöstä. Lisää se paikalliseen ympäristötiedostoon ja aja uudelleen.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join("local/asr/results", stamp);
mkdirSync(outDir, { recursive: true });
console.log(`\nLÄHETETÄÄN ${items.length * modes.length} pyyntöä Googlen Gemini API:lle. Tulokset: ${outDir}\n`);

const retries = Math.max(0, Math.min(10, Number(opt("retries", "3")) || 0));
let lastTimings: StageTimings | undefined;
const gem = new GeminiTranscriber({
  apiKey,
  model,
  engine,
  maxRetries: retries,
  onTimings: (t) => void (lastTimings = t),
  onRetry: (i) => console.log(`    … ${i.status ? `HTTP ${i.status}` : "yhteysvirhe"}, odotetaan ${(i.waitMs / 1000).toFixed(0)} s ja yritetään uudelleen (${i.attempt}/${i.maxRetries})`),
});

const rows: Row[] = [];

for (const it of items) {
  const bytes = new Uint8Array(readFileSync(it.file));
  for (const m of modes) {
    const t0 = Date.now();
    lastTimings = undefined;
    const row: Row = { base: it.base, mode: m, ok: false, seconds: 0 };
    let result: AsrResult | null = null;
    try {
      result = await gem.transcribeBytes(bytes, it.mime, `asr-test-${crypto.randomUUID().slice(0, 8)}`, { languageCodes: [lang], diarize: m === "diarize", timestamps: flag("timestamps"), digits: flag("digits"), thinkingLevel: thinking });
      row.ok = true;
      row.chars = result.text.length;
      row.words = result.words.length;
      if (it.ref) row.score = scoreTranscript(it.ref, result, lang, { solo });
    } catch (e) {
      row.error = e instanceof GeminiError ? e.message : `Odottamaton virhe: ${(e as Error).message.slice(0, 200)}`;
    }
    row.seconds = (Date.now() - t0) / 1000;
    row.timings = lastTimings;
    rows.push(row);
    writeFileSync(join(outDir, `${it.base}.${m}.json`), JSON.stringify({ file: it.base, mode: m, language: lang, model, engine, digits: flag("digits") && engine === "prompt", thinking: engine === "prompt" ? (thinking ?? null) : null, requestSeconds: row.seconds, error: row.error ?? null, timings: row.timings ?? null, score: row.score ?? null, result }, null, 2));
    console.log(`  ${it.base} [${m}] ${row.ok ? `OK ${row.seconds.toFixed(1)} s${row.score ? `, WER ${pct(row.score.wer.wer)}` : ", ei viitettä"}` : `VIRHE ${row.error}`}`);
    if (row.timings) console.log(`    ${formatTimings(row.timings)}`);
  }
}

printSummary(rows, modes);
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ lang, model, modes, rows }, null, 2));
console.log(`\nTulokset ja raakavastaukset: ${outDir}`);
console.log("Huom: pieni, tekijän itse tekemä joukko; luvut ovat suuntaa antavia. Hyväksymisrajoja ei ole sovittu.");
