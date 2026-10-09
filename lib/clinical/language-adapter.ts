import type { z } from "zod";
import type { Fact } from "./facts";
import { JevError, JevClient } from "./jev-client";
import { interpretWithJev, type InterpretDiagnostics } from "./jev-interpreter";
import { mockAnswer, mockInterpretQuestion } from "./mock-language";
import { mockStructure } from "./mock-structurer";
import type { InfoNeed, Transcript } from "./schemas";
import type { JevSettingsResult } from "../jev-settings";

/** "hybrid": osa toiminnoista tekee mallipalvelu, osa sovelluksen omat säännöt. */
export type LanguageAdapterKind = "mock" | "model" | "hybrid" | "unavailable";

/** Kuka kunkin toiminnon oikeasti tekee. Käyttöliittymä näyttää tämän rehellisesti. */
export type CapabilitySource = "model" | "mock" | "deterministic" | "unavailable";
export interface AdapterCapabilities {
  interpretQuestion: CapabilitySource;
  answer: CapabilitySource;
  structureTranscript: CapabilitySource;
}

export interface InterpretContext {
  today: string;
  hasEncounter: boolean;
  signal?: AbortSignal;
  /** Tekniset tiedot tulkinnasta (esim. todennäköisyydet) käyttöliittymän lisätietoihin. */
  onDiagnostics?: (d: InterpretDiagnostics) => void;
}

/**
 * Kielimallin rajapinta. Toteutukset palauttavat raakavastauksen; sovellus validoi
 * sen aina skeemaa vasten ennen käyttöä. Malli ei saa työkaluja eikä kirjoitusoikeutta.
 */
export interface ClinicalLanguageAdapter {
  readonly name: string;
  readonly kind: LanguageAdapterKind;
  readonly description: string;
  readonly capabilities: AdapterCapabilities;
  interpretQuestion(question: string, ctx: InterpretContext): Promise<unknown>;
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
  readonly capabilities: AdapterCapabilities = { interpretQuestion: "mock", answer: "deterministic", structureTranscript: "mock" };
  async interpretQuestion(question: string, ctx: InterpretContext) {
    return mockInterpretQuestion(question, ctx.today);
  }
  async answer(question: string, need: InfoNeed, facts: Fact[], missing: string[]) {
    return mockAnswer(need, facts, missing);
  }
  async structureTranscript(t: Transcript) {
    return mockStructure(t);
  }
}

/**
 * Jev tulkitsee kysymyksen (luokittelu). Jev ei kirjoita tekstiä, joten vastauksen kokoaa
 * sovellus suoraan haetuista faktoista ja litteraatin rakenteistus on toistaiseksi mock-sääntöjä.
 */
export class JevLanguageAdapter implements ClinicalLanguageAdapter {
  readonly name = "Jev";
  readonly kind = "hybrid" as const;
  readonly description =
    "Kysymysten tulkinta: Jev (vain kysymysteksti lähetetään). Vastaus koostetaan suoraan haetuista resursseista, ja litteraatin rakenteistus on mock-sääntöpohjainen.";
  readonly capabilities: AdapterCapabilities = { interpretQuestion: "model", answer: "deterministic", structureTranscript: "mock" };
  constructor(private client: Pick<JevClient, "ask">) {}
  async interpretQuestion(question: string, ctx: InterpretContext) {
    try {
      return await interpretWithJev(this.client, question, ctx);
    } catch (e) {
      // Viesti on valmiiksi siivottu (ei avainta, kysymystä eikä vastauksen runkoa).
      if (e instanceof JevError) throw new LanguageServiceUnavailable(e.message);
      throw e;
    }
  }
  async answer(_question: string, need: InfoNeed, facts: Fact[], missing: string[]) {
    return mockAnswer(need, facts, missing);
  }
  async structureTranscript(t: Transcript) {
    return mockStructure(t);
  }
}

/** Palvelu, jota ei ole kytketty. Ei keksi vastauksia eikä esitä toimivansa. */
export class UnavailableLanguageAdapter implements ClinicalLanguageAdapter {
  readonly kind = "unavailable" as const;
  readonly capabilities: AdapterCapabilities = { interpretQuestion: "unavailable", answer: "unavailable", structureTranscript: "unavailable" };
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

export function createLanguageAdapter(
  cfg: { provider: "mock" | "jev" | "none" },
  jev?: JevSettingsResult,
  fetchImpl?: typeof fetch,
): ClinicalLanguageAdapter {
  if (cfg.provider === "mock") return new MockLanguageAdapter();
  if (cfg.provider === "jev") {
    if (!jev?.ok) {
      return new UnavailableLanguageAdapter("Jev", `LLM_PROVIDER=jev, mutta Jev-yhteyttä ei voitu muodostaa: ${jev?.reason ?? "asetukset puuttuvat"}`);
    }
    return new JevLanguageAdapter(new JevClient({ ...jev.settings, fetchImpl }));
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
