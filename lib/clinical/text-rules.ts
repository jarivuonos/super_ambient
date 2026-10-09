// Jaetut suomenkieliset tekstisäännöt (regex). Käytössä sekä mock-rakenteistajassa että Jev-hybridissä:
// koodi poimii lainaukset, arvot ja termit; Jev vain arvioi niiden merkityksen.

import type { Speaker } from "./schemas";

export const L = "\\p{L}";
export const NB = `(?<!${L})`; // sanan alku
export const NE = `(?!${L})`; // sanan loppu

export const FAMILY_RE = new RegExp(`${NB}(isä|äiti|äidi|veli|velje|sisko|sisar|mummo|mummi|isoisä|isoäiti|isovanhem|vaari|suvussa|sukulais|serkku|eno|täti|setä)`, "iu");
export const NEG_RE = new RegExp(`${NB}(ei|eikä|en|et|emme|ette|eivät|ilman)${NE}`, "iu");

export const SYMPTOMS: { re: RegExp; name: string; partitive: string }[] = [
  { re: /kip(u|ua|uja|eä|ea)|särky|särkee|särkyä|säryt/iu, name: "kipu", partitive: "kipua" },
  { re: /kuume/iu, name: "kuume", partitive: "kuumetta" },
  { re: /yskä|yski|yskii/iu, name: "yskä", partitive: "yskää" },
  { re: /pahoinvoi/iu, name: "pahoinvointi", partitive: "pahoinvointia" },
  { re: /oksen/iu, name: "oksentelu", partitive: "oksentelua" },
  { re: /huimaa|huimau/iu, name: "huimaus", partitive: "huimausta" },
  { re: /hengenahdist|hengästy/iu, name: "hengenahdistus", partitive: "hengenahdistusta" },
  { re: /ripul/iu, name: "ripuli", partitive: "ripulia" },
  { re: /väsyny|väsymy/iu, name: "väsymys", partitive: "väsymystä" },
];

export const LOCATION_RE = new RegExp(
  `${NB}((?:oikea|oikealla|oikean|vasen|vasemmalla|vasemman)\\s+)?((?:ala|ylä)?(?:vatsa|rintakehä|rinta|pää|selkä|selä|kurkku|kurku|nivu|lonkka|polvi|olka)${L}*)`,
  "iu",
);
export const TIME_RE = new RegExp(
  `${NB}(eilisillasta|eilisestä|eilen|tänään|toissapäivänä|viime yönä|aamusta|aamulla|illalla|(?:\\d+|pari|muutama|kolme|kaksi)\\s*(?:päivä|viiko|viikk|tunni|vuorokau|kuukau|vuo)${L}*)(\\s+(?:asti|alkaen|lähtien|sitten|ajan))?`,
  "iu",
);
export const SUSPECT_RE = new RegExp(
  `${NB}(epäilen|epäilisin|epäily|epäillään|epäilty|mahdollinen|mahdollisesti|todennäköisesti|viittaa|sopisi)\\s+([${L}\\- ]{3,60})`,
  "iu",
);
export const YEAR_RE = /(vuonna\s+)?((?:19|20)\d{2})/u;

/** Onko avainsana kielletty samassa lauseen osassa ennen avainsanaa. */
export function negatedBefore(sentence: string, index: number): boolean {
  const before = sentence.slice(0, index);
  const clauseStart = Math.max(before.lastIndexOf(","), before.toLowerCase().lastIndexOf(" mutta "), before.lastIndexOf(";"));
  const clause = before.slice(clauseStart + 1);
  return NEG_RE.test(clause);
}

/** Valitsee sijainniksi ilmauksen, joka ei ole itse oiresana (esim. "vatsakipua"). */
export function findLocation(text: string): string | null {
  const re = new RegExp(LOCATION_RE.source, "giu");
  let best: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const word = m[0].trim();
    if (/kip|sär/iu.test(word)) continue;
    if (!best || m[1]) best = word;
    if (m[1]) break;
  }
  return best;
}

export function speakerLabel(s: Speaker): string {
  return s === "ammattilainen" ? "Ammattilainen" : s === "potilas" ? "Potilas" : s === "läheinen" ? "Läheinen" : "Tuntematon puhuja";
}

/** Normalisoi lauseen ensimmäisen tunnistetun oireen ("Kipu, sijainti: …" / "Ei kuumetta"). */
export function describeSymptom(text: string, negated: boolean): { name: string; text: string; time: string | null } | null {
  for (const sym of SYMPTOMS) {
    if (!sym.re.test(text)) continue;
    const loc = sym.name === "kipu" ? findLocation(text) : null;
    const time = TIME_RE.exec(text);
    return {
      name: sym.name,
      text: negated ? `Ei ${sym.partitive}` : `${sym.name[0].toUpperCase()}${sym.name.slice(1)}${loc ? `, sijainti: ${loc}` : ""}`,
      time: time ? time[0].trim() : null,
    };
  }
  return null;
}

/** Epäilyn kohde ("Epäilen appendisiittia" → "appendisiittia") ja sen paikka lauseessa. */
export function suspectedTerm(text: string): { term: string; index: number; end: number } | null {
  const m = SUSPECT_RE.exec(text);
  if (!m) return null;
  return { term: m[2].trim().replace(/\s+(ja|sekä|tai)\s.*$/iu, ""), index: m.index, end: m.index + m[0].length };
}
