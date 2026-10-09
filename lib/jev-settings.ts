// Jev-asetusten luku ympäristöstä. Ei `server-only`-riippuvuutta, jotta testit ja skriptit voivat käyttää tätä.
// Avain pysyy palvelimella: tämä moduuli ei koskaan palauta avainta käyttöliittymälle.

export const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";

export interface JevSettings {
  apiKey: string;
  endpoint: string;
  model: string;
}

export interface StructuringSettings {
  /** "jev": litteraatin lauseet lähetetään Typesafelle luokiteltaviksi. Oletus on mock (ei lähetetä). */
  structuring: "jev" | "mock";
  /** Samanaikaisten Jev-pyyntöjen määrä (1–8). Oletus 1 vastaa alinta tilausta. */
  concurrency: number;
}

export function readStructuringSettings(env: Record<string, string | undefined>): StructuringSettings {
  const structuring = (env.LLM_STRUCTURING || "mock").trim().toLowerCase() === "jev" ? "jev" : "mock";
  const c = Number.parseInt(env.JEV_CONCURRENCY ?? "", 10);
  return { structuring, concurrency: Number.isFinite(c) ? Math.min(8, Math.max(1, c)) : 1 };
}

export type JevSettingsResult = { ok: true; settings: JevSettings } | { ok: false; reason: string };

export function readJevSettings(env: Record<string, string | undefined>): JevSettingsResult {
  const apiKey = (env.TYPESAFE_API_KEY || env.LLM_API_KEY || "").trim();
  if (!apiKey) return { ok: false, reason: "Avainta ei ole asetettu (TYPESAFE_API_KEY)." };
  let url: URL;
  try {
    url = new URL((env.LLM_ENDPOINT || DEFAULT_JEV_ENDPOINT).trim());
  } catch {
    return { ok: false, reason: "LLM_ENDPOINT ei ole kelvollinen osoite." };
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, reason: "LLM_ENDPOINT:n tulee olla https-osoite ilman tunnuksia." };
  }
  return { ok: true, settings: { apiKey, endpoint: url.toString(), model: (env.LLM_MODEL || DEFAULT_JEV_MODEL).trim() } };
}
