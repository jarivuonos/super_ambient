// Dialogin puhesynteesin suunnittelu (puhdasta logiikkaa): äänet rooleille, taukojen pituudet, yhteenveto.

import { createHash } from "node:crypto";
import { tokenize } from "./metrics";
import type { Reference } from "./references";

/** Gemini TTS:n esiasetetut äänet (dokumentaatiossa 30; sukupuolta ei ilmoiteta, joten kuuntele ja vaihda tarvittaessa). */
export const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Erinome", "Rasalgethi", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima",
  "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat", "Algieba", "Despina", "Algenib", "Laomedeia",
] as const;

/** Oletusäänet rooleille; kolmen eri äänen vaikeusaste vaihtelee, joten ne ovat vaihdettavissa valitsimella --voices. */
export const DEFAULT_VOICES: Record<string, string> = { Lääkäri: "Charon", Potilas: "Kore", Läheinen: "Fenrir", Tuntematon: "Zephyr" };

/** "Lääkäri=Charon,Potilas=Kore" -> äänikartta oletusten päälle. Tuntematon äänen nimi on virhe. */
export function parseVoiceMap(arg: string | undefined): Record<string, string> {
  const map = { ...DEFAULT_VOICES };
  for (const pair of (arg ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [role, voice] = pair.split("=").map((x) => x.trim());
    if (!role || !voice) throw new Error(`Virheellinen --voices-osa "${pair}" (muoto Rooli=Ääni).`);
    const known = GEMINI_VOICES.find((v) => v.toLowerCase() === voice.toLowerCase());
    if (!known) throw new Error(`Tuntematon ääni "${voice}". Sallitut: ${GEMINI_VOICES.join(", ")}.`);
    map[role] = known;
  }
  return map;
}

/** Tauko puheenvuoron jälkeen: puhujan vaihtuessa `gapMs`, saman puhujan jatkaessa puolet siitä. */
export function turnGaps(who: string[], gapMs: number): number[] {
  return who.map((w, i) => (i < who.length - 1 ? (who[i + 1] === w ? Math.round(gapMs / 2) : gapMs) : 0));
}

export interface PlannedTurn {
  who: string;
  voice: string;
  text: string;
}

export function planTurns(ref: Reference, voices: Record<string, string>): PlannedTurn[] {
  return ref.turns.map((t) => ({ who: t.who, voice: voices[t.who] ?? voices.Tuntematon, text: t.text }));
}

export function planSummary(turns: PlannedTurn[]): { turns: number; chars: number; words: number; estMinutes: number } {
  const words = turns.reduce((n, t) => n + tokenize(t.text).length, 0);
  return { turns: turns.length, chars: turns.reduce((n, t) => n + t.text.length, 0), words, estMinutes: words / 140 };
}

/** Välimuistiavain yhdelle puheenvuorolle: sama malli, ääni, tyyli ja teksti antavat saman tiedoston (säästää pyyntöjä uusinnoissa). */
export function turnCacheKey(model: string, voice: string, style: string, text: string): string {
  return createHash("sha1").update(JSON.stringify([model, voice, style, text])).digest("hex").slice(0, 16);
}
