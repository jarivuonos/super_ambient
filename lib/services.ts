import "server-only";
import { createLanguageAdapter, type ClinicalLanguageAdapter } from "./clinical/language-adapter";
import { getConfig, getJevSettings } from "./config";
import type { CapabilityCheck, CapabilitySummary } from "./fhir/ehr-adapter";
import { HapiR4Adapter } from "./fhir/hapi-adapter";
import { createTranscriptionAdapter, type TranscriptionAdapter } from "./transcription/adapter";

// Palvelinpuolen yksittäisinstanssit. FHIR-yhteys ja avaimet pysyvät palvelimella.

let ehr: HapiR4Adapter | undefined;
let language: ClinicalLanguageAdapter | undefined;
let transcription: TranscriptionAdapter | undefined;
let lastCheck: CapabilityCheck | undefined;
let lastSuccess: { at: string; summary: CapabilitySummary } | undefined;

export function getEhr(): HapiR4Adapter {
  if (!ehr) {
    const cfg = getConfig();
    ehr = new HapiR4Adapter({ baseUrl: cfg.fhirBaseUrl, timeoutMs: cfg.fhirTimeoutMs });
  }
  return ehr;
}

export function getLanguage(): ClinicalLanguageAdapter {
  if (!language) language = createLanguageAdapter(getConfig().llm, getJevSettings());
  return language;
}

export function getTranscription(): TranscriptionAdapter {
  if (!transcription) transcription = createTranscriptionAdapter(getConfig().transcription);
  return transcription;
}

export async function checkCapabilities(force = false): Promise<{ check: CapabilityCheck; lastSuccess?: typeof lastSuccess }> {
  const fresh = lastCheck && Date.now() - Date.parse(lastCheck.checkedAt) < 5 * 60 * 1000;
  if (force || !fresh) {
    lastCheck = await getEhr().checkCapabilities();
    if (lastCheck.ok) lastSuccess = { at: lastCheck.checkedAt, summary: lastCheck.summary };
  }
  return { check: lastCheck!, lastSuccess };
}

/** Tallennusta varten: viimeisin onnistunut kyvykkyystieto (haetaan tarvittaessa). */
export async function getCapabilitySummary(): Promise<CapabilitySummary | null> {
  const { lastSuccess: ls } = await checkCapabilities(false);
  return ls?.summary ?? null;
}

/** Turvallinen lokitus: ei kliinistä sisältöä, litteraatteja eikä avaimia. */
export function logError(where: string, e: unknown) {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : "tuntematon virhe";
  console.error(`[${where}] ${msg.slice(0, 200)}`);
}

export function jsonError(message: string, status: number, detail?: unknown) {
  return Response.json({ error: { message, detail } }, { status });
}
