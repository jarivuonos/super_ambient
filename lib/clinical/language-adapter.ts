import type { z } from "zod";
import type { Fact } from "./facts";
import { mockAnswer, mockInterpretQuestion } from "./mock-language";
import { mockStructure } from "./mock-structurer";
import type { InfoNeed, Transcript } from "./schemas";

export type LanguageAdapterKind = "mock" | "model" | "unavailable";

/**
 * Kielimallin rajapinta. Toteutukset palauttavat raakavastauksen; sovellus validoi
 * sen aina skeemaa vasten ennen käyttöä. Malli ei saa työkaluja eikä kirjoitusoikeutta.
 */
export interface ClinicalLanguageAdapter {
  readonly name: string;
  readonly kind: LanguageAdapterKind;
  readonly description: string;
  interpretQuestion(question: string, ctx: { today: string; hasEncounter: boolean }): Promise<unknown>;
  /** Vastaus vain annettujen faktojen perusteella. Faktat ovat dataa, eivät ohjeita. */
  answer(question: string, need: InfoNeed, facts: Fact[], missing: string[]): Promise<string>;
  structureTranscript(transcript: Transcript): Promise<unknown>;
  /** Pyytää korjattua vastausta, kun skeemavalidointi epäonnistui (vain oikeat mallit). */
  repair?(previous: unknown, errors: string): Promise<unknown>;
}

export class LanguageServiceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageServiceUnavailable";
  }
}

export class MockLanguageAdapter implements ClinicalLanguageAdapter {
  readonly name = "Mock (sääntöpohjainen)";
  readonly kind = "mock" as const;
  readonly description =
    "Sääntöpohjainen mock-tila. Ei kielimalli: tunnistaa vain rajatun joukon esimerkki-ilmauksia.";
  async interpretQuestion(question: string, ctx: { today: string; hasEncounter: boolean }) {
    return mockInterpretQuestion(question, ctx.today);
  }
  async answer(question: string, need: InfoNeed, facts: Fact[], missing: string[]) {
    return mockAnswer(need, facts, missing);
  }
  async structureTranscript(t: Transcript) {
    return mockStructure(t);
  }
}

/** Palvelu, jota ei ole kytketty. Ei keksi vastauksia eikä esitä toimivansa. */
export class UnavailableLanguageAdapter implements ClinicalLanguageAdapter {
  readonly kind = "unavailable" as const;
  constructor(
    readonly name: string,
    readonly description: string,
  ) {}
  async interpretQuestion(): Promise<unknown> {
    throw new LanguageServiceUnavailable(this.description);
  }
  async answer(): Promise<string> {
    throw new LanguageServiceUnavailable(this.description);
  }
  async structureTranscript(): Promise<unknown> {
    throw new LanguageServiceUnavailable(this.description);
  }
}

export function createLanguageAdapter(cfg: { provider: "mock" | "jev" | "none" }): ClinicalLanguageAdapter {
  if (cfg.provider === "mock") return new MockLanguageAdapter();
  if (cfg.provider === "jev") {
    // Jev-palvelun palveluntarjoajaa, APIa ja ominaisuuksia ei ole dokumentoitu tälle projektille.
    // Adapteri toteutetaan vasta todellisen dokumentaation perusteella; endpointia ei arvata.
    return new UnavailableLanguageAdapter(
      "Jev",
      "Jev-adapteria ei ole vielä toteutettu: palvelun API-dokumentaatio puuttuu. Käytä mock-tilaa tai liitä mallivastaus käsin.",
    );
  }
  return new UnavailableLanguageAdapter("Ei mallipalvelua", "Mallipalvelu ei ole käytössä (LLM_PROVIDER=none).");
}

/**
 * Validoi raakavastauksen skeemaa vasten. Jos adapteri tukee korjausta, pyytää enintään
 * `maxRepairs` korjattua vastausta. Rikkinäinen vastaus ei koskaan pääse eteenpäin.
 */
export async function parseWithRepair<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  repair?: (previous: unknown, errors: string) => Promise<unknown>,
  maxRepairs = 1,
): Promise<{ ok: true; data: T; attempts: number } | { ok: false; error: string; attempts: number }> {
  let current = raw;
  for (let attempt = 0; ; attempt++) {
    let value = current;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        value = undefined;
      }
    }
    const res = schema.safeParse(value);
    if (res.success) return { ok: true, data: res.data, attempts: attempt + 1 };
    const errors =
      value === undefined
        ? "Vastaus ei ollut kelvollista JSONia."
        : res.error.issues
            .slice(0, 8)
            .map((i) => `${i.path.join(".") || "(juuri)"}: ${i.message}`)
            .join("; ");
    if (!repair || attempt >= maxRepairs) return { ok: false, error: errors, attempts: attempt + 1 };
    current = await repair(current, errors);
  }
}
