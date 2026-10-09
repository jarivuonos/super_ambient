// Tiedontarpeen jaetut määritelmät: käytetään sekä mock-tulkinnassa että Jev-tulkinnassa.

import type { InfoNeed, Intent } from "./schemas";

export type KnownIntent = Exclude<Intent, "unknown">;

export const INTENT_PROFILE: Record<KnownIntent, { types: InfoNeed["resourceTypes"]; concepts: string[]; fi: string }> = {
  "blood-pressure": { types: ["Observation"], concepts: ["verenpaine"], fi: "verenpaine" },
  "vital-signs": { types: ["Observation"], concepts: ["vitaalimittaukset"], fi: "muut vitaalimittaukset" },
  laboratory: { types: ["Observation"], concepts: ["laboratoriotulokset"], fi: "laboratoriotulokset" },
  medications: { types: ["MedicationStatement", "MedicationRequest"], concepts: ["lääkitys"], fi: "lääkitys" },
  allergies: { types: ["AllergyIntolerance"], concepts: ["allergiat"], fi: "allergiat" },
  conditions: { types: ["Condition"], concepts: ["diagnoosit"], fi: "diagnoosit ja ongelmat" },
  "imaging-report": { types: ["DiagnosticReport", "DocumentReference"], concepts: ["kuvantamislausunto"], fi: "kuvantamislausunnot" },
  documents: { types: ["DocumentReference"], concepts: ["asiakirjat"], fi: "asiakirjat" },
  overview: {
    types: ["Condition", "Observation", "MedicationStatement", "AllergyIntolerance", "DiagnosticReport"],
    concepts: ["ongelmat", "poikkeavat havainnot", "muutokset"],
    fi: "yhteenveto potilaan tilanteesta",
  },
};

export const KNOWN_INTENTS = Object.keys(INTENT_PROFILE) as KnownIntent[];

export const PERIODS = ["none", "week", "month", "year"] as const;
export type Period = (typeof PERIODS)[number];
const PERIOD_DAYS: Record<Exclude<Period, "none">, number> = { week: 7, month: 30, year: 365 };

export function daysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Aikaväli päivämääräksi. Päivämäärän laskee aina sovellus, ei malli. */
export function periodToSince(period: Period, today: string): string | null {
  return period === "none" ? null : daysAgo(today, PERIOD_DAYS[period]);
}

export const CLARIFY_GENERIC =
  "En tunnistanut tiedontarvetta. Tarkoitatko esimerkiksi verenpaineita, lääkitystä, allergioita, laboratoriotuloksia, lausuntoja vai ongelmien yhteenvetoa?";

export function clarifyNear(intent: KnownIntent): string {
  return `En ole varma, mitä tietoa tarkoitit (lähin vaihtoehto: ${INTENT_PROFILE[intent].fi}). Tarkenna kysymystä tai valitse esimerkkikysymys.`;
}
