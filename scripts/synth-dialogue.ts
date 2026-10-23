// Synteettisten dialogien puhesynteesi koeajon testiaineistoksi (Gemini TTS). EI kuulu sovellukseen; ajaa omistaja.
//
//   bun run asr:synth                                   Luettelo esimerkkikeskusteluista ja oletusäänistä
//   bun run asr:synth -- --ids t01,t02                  Kuivaajo: suunnitelma, EI lähetä mitään
//   bun run asr:synth -- --ids t01 --send               Syntetisoi: jokainen puheenvuoro roolinsa äänellä, liitetään yhdeksi WAV-tiedostoksi
//
// Valitsimet: --all (kaikki esimerkit) · --out local/asr/tts · --lang fi (tiedostonimen etuliite) ·
//   --voices "Lääkäri=Charon,Potilas=Kore,Läheinen=Fenrir" · --gap 700 (ms puhujan vaihtuessa) · --style "ohje" ·
//   --model gemini-3.8-flash-tts · --retries 3
//
// Tulos: <out>/<lang>-<tunniste>.wav, jonka viite on esimerkin oma teksti: aja koeajo `bun run eval:transcribe -- --dir local/asr/tts`.
// Puheenvuorot välimuistitetaan (<out>/parts), joten uusinta ei lähetä jo tehtyjä uudelleen.
// Teksti on kokonaan synteettistä; avain luetaan ympäristömuuttujasta GEMINI_API_KEY eikä sitä tulosteta.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_CONVERSATIONS } from "../lib/clinical/sample-conversations";
import { findReference } from "./asr/references";
import { planSummary, planTurns, parseVoiceMap, turnCacheKey, turnGaps } from "./asr/synth-plan";
import { DEFAULT_TTS_MODEL, GeminiSpeaker } from "./asr/tts";
import { GeminiError } from "./asr/gemini";
import { durationSeconds, joinWav } from "./asr/wav";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

const model = opt("model", DEFAULT_TTS_MODEL);
const out = opt("out", "local/asr/tts");
const lang = opt("lang", "fi");
const gap = Math.max(0, Number(opt("gap", "700")) || 0);
const style = opt("style", "");
const retries = Math.max(0, Math.min(10, Number(opt("retries", "3")) || 0));

let voices: Record<string, string>;
try {
  voices = parseVoiceMap(opt("voices", ""));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const wanted = flag("all") ? SAMPLE_CONVERSATIONS.map((s) => s.id) : opt("ids", "").split(",").filter(Boolean);
const refs = wanted.map((id) => ({ id, ref: findReference(id) }));
const unknown = refs.filter((r) => !r.ref).map((r) => r.id);
if (unknown.length) {
  console.error(`Tuntemattomat tunnisteet: ${unknown.join(", ")}. Katso luettelo komennolla bun run asr:synth.`);
  process.exit(1);
}

console.log(`Äänet: ${Object.entries(voices).map(([r, v]) => `${r}=${v}`).join(", ")}  (sukupuolta ei ilmoiteta dokumentaatiossa: kuuntele ja vaihda --voices)`);
if (!refs.length) {
  console.log("\nEsimerkkikeskustelut (valitse --ids tai --all):");
  for (const s of SAMPLE_CONVERSATIONS) {
    const sum = planSummary(planTurns(findReference(s.id)!, voices));
    console.log(`  ${s.id.padEnd(14)} ${String(sum.turns).padStart(2)} vuoroa, ${String(sum.words).padStart(3)} sanaa (~${sum.estMinutes.toFixed(1)} min)  ${s.title}`);
  }
  process.exit(0);
}

console.log(`Malli ${model} · kieli ${lang} · tauko ${gap} ms · kansio ${out}${style ? ` · tyyli "${style}"` : ""}\n`);
let requests = 0;
for (const { id, ref } of refs) {
  const turns = planTurns(ref!, voices);
  const sum = planSummary(turns);
  const roles = [...new Set(turns.map((t) => `${t.who}=${t.voice}`))].join(", ");
  console.log(`  ${id.padEnd(14)} ${sum.turns} vuoroa, ${sum.chars} merkkiä, ~${sum.estMinutes.toFixed(1)} min · ${roles}`);
  requests += sum.turns;
}

if (!flag("send")) {
  console.log(`\nKuivaajo: mitään ei lähetetty. ${requests} pyyntöä Googlelle (yksi per puheenvuoro, välimuistissa olevat ohitetaan), kun lisäät --send.`);
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("\nGEMINI_API_KEY puuttuu ympäristöstä. Lisää se paikalliseen ympäristötiedostoon ja aja uudelleen.");
  process.exit(1);
}

mkdirSync(join(out, "parts"), { recursive: true });
const speaker = new GeminiSpeaker({
  apiKey,
  model,
  maxRetries: retries,
  onRetry: (i) => console.log(`    … ${i.status ? `HTTP ${i.status}` : "yhteysvirhe"}, odotetaan ${(i.waitMs / 1000).toFixed(0)} s ja yritetään uudelleen (${i.attempt}/${i.maxRetries})`),
});

console.log(`\nLÄHETETÄÄN enintään ${requests} puheenvuoroa Googlen Gemini API:lle.\n`);
let failed = false;
for (const { id, ref } of refs) {
  const turns = planTurns(ref!, voices);
  const parts: Uint8Array[] = [];
  try {
    for (const [i, t] of turns.entries()) {
      const cache = join(out, "parts", `${turnCacheKey(model, t.voice, style, t.text)}.wav`);
      if (existsSync(cache)) {
        parts.push(new Uint8Array(readFileSync(cache)));
        console.log(`  ${id} ${i + 1}/${turns.length} [${t.who}/${t.voice}] välimuistista`);
        continue;
      }
      const wav = await speaker.speak(t.text, t.voice, style || undefined);
      writeFileSync(cache, wav);
      parts.push(wav);
      console.log(`  ${id} ${i + 1}/${turns.length} [${t.who}/${t.voice}] ${durationSeconds(wav).toFixed(1)} s`);
    }
    const joined = joinWav(parts, turnGaps(turns.map((t) => t.who), gap));
    const file = join(out, `${lang}-${id}.wav`);
    writeFileSync(file, joined);
    writeFileSync(join(out, `${lang}-${id}.tts.json`), JSON.stringify({ id, model, voices: Object.fromEntries(turns.map((t) => [t.who, t.voice])), gapMs: gap, style, turns: turns.length }, null, 2));
    console.log(`  → ${file} (${durationSeconds(joined).toFixed(1)} s)\n`);
  } catch (e) {
    failed = true;
    console.log(`  VIRHE ${id}: ${e instanceof GeminiError ? e.message : (e as Error).message.slice(0, 200)} (jo tehdyt puheenvuorot säilyvät välimuistissa)\n`);
  }
}
console.log(failed ? "Osa dialogeista epäonnistui; aja sama komento uudelleen, niin vain puuttuvat puheenvuorot haetaan." : `Valmis. Aja litterointikoe: bun run eval:transcribe -- --dir ${out} --mode both`);
