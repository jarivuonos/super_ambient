import "server-only";
import { sessionFromRequest } from "./auth/session";
import { createLanguageAdapter, type ClinicalLanguageAdapter } from "./clinical/language-adapter";
import { getConfig, getJevSettings } from "./config";
import type { CapabilityCheck, CapabilitySummary } from "./fhir/ehr-adapter";
import { HapiR4Adapter } from "./fhir/hapi-adapter";
import { DEFAULT_SOURCE_ID, findSource, isWritable, resolveBaseUrl, type EhrSource } from "./fhir/sources";
import { createTranscriptionAdapter, type TranscriptionAdapter } from "./transcription/adapter";

// Palvelinpuolen yksittäisinstanssit. FHIR-yhteys ja avaimet pysyvät palvelimella.

const ehrBySource = new Map<string, HapiR4Adapter>();
let language: ClinicalLanguageAdapter | undefined;
let transcription: TranscriptionAdapter | undefined;
const lastCheckBySource = new Map<string, CapabilityCheck>();
const lastSuccessBySource = new Map<string, { at: string; summary: CapabilitySummary }>();

function buildAdapter(source: EhrSource, accessToken?: string): HapiR4Adapter {
  return new HapiR4Adapter({
    baseUrl: resolveBaseUrl(source, process.env),
    timeoutMs: getConfig().fhirTimeoutMs,
    accessToken,
    name: source.id === DEFAULT_SOURCE_ID ? undefined : source.label,
    patientNameSearch: source.patientNameSearch,
  });
}

/**
 * FHIR-lähteen liitäntä ilman käyttäjän tunnistetta (välimuistissa). Kirjautumista vaativalla lähteellä
 * tällä voi hakea vain julkisen /metadata-tiedon; potilastiedot haetaan `resolveEhr`-funktiolla.
 * Tuntematon lähde on ohjelmointivirhe: reitit validoivat tunnisteen ennen tätä.
 */
export function getEhr(sourceId: string = DEFAULT_SOURCE_ID): HapiR4Adapter {
  let ehr = ehrBySource.get(sourceId);
  if (!ehr) {
    const source = findSource(sourceId);
    if (!source) throw new Error("Tuntematon FHIR-lähde.");
    ehr = buildAdapter(source);
    ehrBySource.set(sourceId, ehr);
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

export type ResolvedEhr = { ehr: HapiR4Adapter; response?: undefined } | { ehr?: undefined; response: Response };

/**
 * Liitäntä yhden pyynnön ajaksi. Kirjautumista vaativalla lähteellä käyttäjän pääsytunniste luetaan
 * pyynnön evästeestä ja liitäntä rakennetaan joka pyynnölle: tunnistetta ei koskaan jaeta käyttäjien kesken
 * eikä tallenneta palvelimen muistiin. Ilman voimassa olevaa tunnistetta palautetaan 401.
 */
export function resolveEhr(sourceId: string, request: Request): ResolvedEhr {
  const source = findSource(sourceId);
  if (!source) return { response: jsonError("Tuntematon FHIR-lähde.", 400) };
  if (source.auth.kind === "none") return { ehr: getEhr(sourceId) };
  const session = sessionFromRequest(request, sourceId);
  if (!session) return { response: jsonError("Kirjautuminen vaaditaan.", 401, { kind: "login-required" }) };
  return {
    ehr: buildAdapter(source, session.accessToken),
  };
}

export async function checkCapabilities(
  sourceId: string = DEFAULT_SOURCE_ID,
  force = false,
): Promise<{ check: CapabilityCheck; lastSuccess?: { at: string; summary: CapabilitySummary } }> {
  const prev = lastCheckBySource.get(sourceId);
  const fresh = prev && Date.now() - Date.parse(prev.checkedAt) < 5 * 60 * 1000;
  if (force || !fresh) {
    const check = await getEhr(sourceId).checkCapabilities();
    lastCheckBySource.set(sourceId, check);
    if (check.ok) lastSuccessBySource.set(sourceId, { at: check.checkedAt, summary: check.summary });
  }
  return { check: lastCheckBySource.get(sourceId)!, lastSuccess: lastSuccessBySource.get(sourceId) };
}

/** Tallennusta varten: viimeisin onnistunut kyvykkyystieto (haetaan tarvittaessa). */
export async function getCapabilitySummary(sourceId: string = DEFAULT_SOURCE_ID): Promise<CapabilitySummary | null> {
  const { lastSuccess: ls } = await checkCapabilities(sourceId, false);
  return ls?.summary ?? null;
}
/** Turvallinen lokitus: ei kliinistä sisältöä, litteraatteja eikä avaimia. */
export function logError(where: string, e: unknown) {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : "tuntematon virhe";
  console.error(`[${where}] ${msg.slice(0, 200)}`);
}

/** Kirjoitukset vain lähteisiin, jotka rekisterissä on merkitty kirjoitettaviksi. Palauttaa vastauksen, jos kirjoitus estetään. */
export function writeBlocked(sourceId: string): Response | null {
  return isWritable(sourceId) ? null : jsonError("Tähän FHIR-lähteeseen ei kirjoiteta (vain luku).", 403);
}

export function jsonError(message: string, status: number, detail?: unknown) {
  return Response.json({ error: { message, detail } }, { status });
}
