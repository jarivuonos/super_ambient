// Viitelitteraatit: kultajoukon ja esimerkkikeskustelut (lib/clinical/sample-conversations.ts) tai
// äänitiedoston viereinen `<nimi>.ref.txt` (rivit muodossa "Lääkäri: teksti").

import { SAMPLE_CONVERSATIONS } from "../../lib/clinical/sample-conversations";

export interface RefTurn {
  who: string;
  text: string;
}

export interface Reference {
  id: string;
  title: string;
  turns: RefTurn[];
  source: "esimerkki" | "sivutiedosto";
}

const LABELLED = /^\s*(Lääkäri|Potilas|Läheinen)\s*:\s*(.*)$/u;

/** Rivit "Rooli: teksti" puheenvuoroiksi; roolitta jatkuva rivi liitetään edelliseen vuoroon, ensimmäinen roolitta rivi on "Tuntematon". */
export function parseReferenceText(text: string): RefTurn[] {
  const turns: RefTurn[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const m = LABELLED.exec(raw);
    if (m) turns.push({ who: m[1], text: m[2].trim() });
    else if (turns.length) turns[turns.length - 1].text += ` ${raw.trim()}`;
    else turns.push({ who: "Tuntematon", text: raw.trim() });
  }
  return turns;
}

/** `fi-vatsakipu`, `sv-vatsakipu` ja `vatsakipu` viittaavat samaan esimerkkiin. */
export function idFromFileBase(base: string): string {
  return base.replace(/^(fi|sv|en)[-_]/iu, "");
}

export function findReference(fileBase: string, sidecarText?: string): Reference | null {
  if (sidecarText?.trim()) return { id: fileBase, title: "Sivutiedoston viite", turns: parseReferenceText(sidecarText), source: "sivutiedosto" };
  const id = idFromFileBase(fileBase);
  const sample = SAMPLE_CONVERSATIONS.find((s) => s.id === id);
  return sample ? { id: sample.id, title: sample.title, turns: parseReferenceText(sample.text), source: "esimerkki" } : null;
}

export function referenceText(ref: Reference): string {
  return ref.turns.map((t) => `${t.who}: ${t.text}`).join("\n");
}
