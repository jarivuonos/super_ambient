import { LOINC, SNOMED, type Coding } from "../fhir/types";

// Pieni, käsin tarkistettu koodiluettelo. Mallin ehdottama koodi hyväksytään vain,
// jos se löytyy täältä täsmälleen samana; muuten koodi jätetään pois ja käytetään tekstiä.

export interface KnownCondition {
  stems: string[];
  coding: Required<Coding>;
  fi: string;
}

export const KNOWN_CONDITIONS: KnownCondition[] = [
  { stems: ["appendisiit", "umpilisäkkeen tulehd"], coding: { system: SNOMED, code: "74400008", display: "Appendicitis" }, fi: "Appendisiitti" },
  { stems: ["diabete", "sokeritau"], coding: { system: SNOMED, code: "73211009", display: "Diabetes mellitus" }, fi: "Diabetes" },
  { stems: ["verenpainetau", "kohonnut verenpaine", "hypertoni", "hypertensi"], coding: { system: SNOMED, code: "38341003", display: "Hypertensive disorder, systemic arterial" }, fi: "Verenpainetauti" },
  { stems: ["astma"], coding: { system: SNOMED, code: "195967001", display: "Asthma" }, fi: "Astma" },
  { stems: ["migreen"], coding: { system: SNOMED, code: "37796009", display: "Migraine" }, fi: "Migreeni" },
  { stems: ["keuhkokuum", "pneumoni"], coding: { system: SNOMED, code: "233604007", display: "Pneumonia" }, fi: "Keuhkokuume" },
  { stems: ["virtsatieinfek", "virtsatietulehd", "kystiit"], coding: { system: SNOMED, code: "68566005", display: "Urinary tract infectious disease" }, fi: "Virtsatieinfektio" },
  { stems: ["sappikivi", "kolekystiit"], coding: { system: SNOMED, code: "235919008", display: "Gallstone" }, fi: "Sappikivitauti" },
  { stems: ["gastroenteriit", "vatsatau"], coding: { system: SNOMED, code: "25374005", display: "Gastroenteritis" }, fi: "Gastroenteriitti" },
];

export const VITAL_CODES = {
  bpPanel: { system: LOINC, code: "85354-9", display: "Blood pressure panel with all children optional" },
  systolic: { system: LOINC, code: "8480-6", display: "Systolic blood pressure" },
  diastolic: { system: LOINC, code: "8462-4", display: "Diastolic blood pressure" },
  heartRate: { system: LOINC, code: "8867-4", display: "Heart rate" },
  temperature: { system: LOINC, code: "8310-5", display: "Body temperature" },
} as const;

const ALL_KNOWN: Coding[] = [...KNOWN_CONDITIONS.map((k) => k.coding), ...Object.values(VITAL_CODES)];

/** Palauttaa koodin vain, jos se on tunnetussa luettelossa (järjestelmä + koodi täsmäävät). */
export function verifyCoding(c: Coding | null | undefined): Required<Coding> | null {
  if (!c?.system || !c.code) return null;
  const hit = ALL_KNOWN.find((k) => k.system === c.system && k.code === c.code);
  return hit ? (hit as Required<Coding>) : null;
}

export function findKnownCondition(text: string): KnownCondition | undefined {
  const t = text.toLowerCase();
  return KNOWN_CONDITIONS.find((k) => k.stems.some((s) => t.includes(s)));
}
