import "server-only";
import { DEFAULT_JEV_MODEL, readJevSettings, readStructuringSettings, type JevSettingsResult } from "./jev-settings";

// Palvelinpuolen asetukset. Avaimet luetaan vain ympäristömuuttujista.

export interface AppConfig {
  fhirBaseUrl: string;
  fhirTimeoutMs: number;
  llm: {
    provider: "mock" | "jev" | "none";
    model?: string;
    endpoint?: string;
    hasApiKey: boolean;
    /** Rakenteistuksen tekijä; "jev" vain kun LLM_PROVIDER=jev ja LLM_STRUCTURING=jev. */
    structuring: "jev" | "mock";
    concurrency: number;
  };
  transcription: {
    provider: "none" | string;
    endpoint?: string;
    hasApiKey: boolean;
  };
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getConfig(): AppConfig {
  const rawLlm = (process.env.LLM_PROVIDER ?? "mock").trim().toLowerCase();
  const provider = rawLlm === "jev" ? "jev" : rawLlm === "none" ? "none" : "mock";
  return {
    fhirBaseUrl: normalizeBase(process.env.FHIR_BASE_URL ?? "https://hapi.fhir.org/baseR4"),
    fhirTimeoutMs: Number(process.env.FHIR_TIMEOUT_MS ?? 20000),
    llm: {
      provider,
      model: process.env.LLM_MODEL || (provider === "jev" ? DEFAULT_JEV_MODEL : undefined),
      endpoint: process.env.LLM_ENDPOINT || undefined,
      hasApiKey: Boolean(process.env.TYPESAFE_API_KEY || process.env.LLM_API_KEY),
      structuring: provider === "jev" ? readStructuringSettings(process.env).structuring : "mock",
      concurrency: readStructuringSettings(process.env).concurrency,
    },
    transcription: {
      provider: (process.env.TRANSCRIPTION_PROVIDER ?? "none").trim().toLowerCase() || "none",
      endpoint: process.env.TRANSCRIPTION_ENDPOINT || undefined,
      hasApiKey: Boolean(process.env.TRANSCRIPTION_API_KEY),
    },
  };
}

/** Jev-yhteyden asetukset (sisältää avaimen) – vain palvelinpuolen käyttöön. */
export function getJevSettings(): JevSettingsResult {
  return readJevSettings(process.env);
}
