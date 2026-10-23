import { hashValue } from "../util/hash";
import type { Speaker, Transcript, TranscriptSegment } from "./schemas";

const SPEAKER_PREFIXES: [RegExp, Speaker][] = [
  [/^(lääkäri|hoitaja|ammattilainen|kliinikko|terveydenhoitaja|l|h|a)\s*:\s*/i, "ammattilainen"],
  [/^(potilas|p)\s*:\s*/i, "potilas"],
  [/^(läheinen|omainen|puoliso|isä|äiti|tytär|poika|saattaja|o)\s*:\s*/i, "läheinen"],
  [/^(tuntematon|puhuja\s*\d*|\?)\s*:\s*/i, "tuntematon"],
];

export function transcriptVersion(segments: Pick<TranscriptSegment, "speaker" | "text" | "startMs" | "endMs">[]): string {
  return hashValue(segments.map((s) => [s.speaker, s.text, s.startMs, s.endMs]));
}

/**
 * Muuntaa liitetyn tekstin puheenvuoroiksi. Puhujarooli otetaan vain käyttäjän
 * kirjoittamasta etuliitteestä (esim. "Lääkäri:"); muuten puhuja on tuntematon.
 */
export function parsePastedTranscript(text: string, origin: Transcript["origin"] = "liitetty"): Transcript {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let labelled = 0;
  const segments: TranscriptSegment[] = lines.slice(0, 500).map((line, i) => {
    let speaker: Speaker = "tuntematon";
    let speakerLabel: string | undefined;
    let body = line;
    for (const [re, sp] of SPEAKER_PREFIXES) {
      const m = re.exec(line);
      if (m) {
        speaker = sp;
        body = line.slice(m[0].length);
        labelled++;
        // "Puhuja 2:" säilyttää numeron, jotta eri puhujat erottuvat tekstikentässä.
        const n = sp === "tuntematon" ? /puhuja\s*(\d+)/i.exec(m[1])?.[1] : undefined;
        if (n) speakerLabel = `Puhuja ${n}`;
        break;
      }
    }
    return { id: `s${i + 1}`, speaker, ...(speakerLabel ? { speakerLabel } : {}), text: body.slice(0, 5000), startMs: null, endMs: null };
  });
  if (segments.length === 0) {
    segments.push({ id: "s1", speaker: "tuntematon", text: "", startMs: null, endMs: null });
  }
  return {
    version: transcriptVersion(segments),
    origin,
    speakerSource: labelled > 0 ? "käyttäjän merkinnät" : "ei tiedossa",
    segments,
  };
}

/** Palauttaa litteraatin muokattavana tekstinä (puhujaetuliittein). */
export function transcriptToText(t: Transcript): string {
  const label: Record<Speaker, string> = {
    ammattilainen: "Lääkäri",
    potilas: "Potilas",
    läheinen: "Läheinen",
    tuntematon: "Tuntematon",
  };
  return t.segments
    .map((s) => (t.speakerSource === "ei tiedossa" && s.speaker === "tuntematon" ? s.text : `${s.speakerLabel ?? label[s.speaker]}: ${s.text}`))
    .join("\n");
}

/** Tarkistaa, että lähdeviite osoittaa olemassa olevaan kohtaan ja lainaus täsmää. */
export function verifySourceRef(
  t: Transcript,
  ref: { transcriptVersion: string; segmentId: string; start: number; end: number; quote: string },
): string | null {
  if (ref.transcriptVersion !== t.version) return "Lähdeviite koskee eri litteraattiversiota.";
  const seg = t.segments.find((s) => s.id === ref.segmentId);
  if (!seg) return "Lähdeviitteen puheenvuoroa ei löydy.";
  if (ref.end <= ref.start || ref.end > seg.text.length) return "Lähdeviitteen merkkialue on virheellinen.";
  if (seg.text.slice(ref.start, ref.end) !== ref.quote) return "Lähdelainaus ei vastaa litteraattia.";
  return null;
}

export const SAMPLE_TRANSCRIPT = `Lääkäri: Mikä tuo tänään vastaanotolle?
Potilas: Minulla on ollut vatsakipua oikealla alavatsalla eilisillasta asti.
Potilas: Pahoinvointia on ollut, mutta en ole oksentanut.
Lääkäri: Onko ollut kuumetta?
Potilas: Ei kuumetta.
Läheinen: Hänen isällään on diabetes, jos sillä on merkitystä.
Potilas: Käytän amlodipiinia 5 mg kerran päivässä. Penisilliinistä tulee ihottumaa.
Potilas: Sappirakko on leikattu vuonna 2019.
Lääkäri: Verenpaine oli ensin 160/100, uusintamittauksessa 145/90. Syke 78.
Lääkäri: Oikea alavatsa on palpaatioarka. Epäilen appendisiittia.
Lääkäri: Otetaan CRP ja pieni verenkuva, ja lähetän sinut päivystykseen jatkoarvioon.`;
