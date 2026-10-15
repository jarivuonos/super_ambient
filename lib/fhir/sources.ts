import { z } from "zod";

// FHIR-lähteiden rekisteri. Selain valitsee lähteen vain tunnisteella (`id`);
// osoite, tunnistautuminen ja kirjoitusoikeus tulevat aina tästä rekisteristä.
// Ei `server-only`-tuontia, jotta tämä on testattavissa.

export type SourceAuth =
  | { kind: "none" }
  /** SMART on FHIR, standalone launch, julkinen asiakas (ei salaisuutta), PKCE. */
  | { kind: "smart-standalone"; clientIdEnv: string; scopes: string[] };

export interface EhrSource {
  id: string;
  label: string;
  description: string;
  /** Oletusosoite; `baseUrlEnv` voi ohittaa sen. */
  baseUrl: string;
  baseUrlEnv?: string;
  auth: SourceAuth;
  /** false: sovellus ei kirjoita tähän lähteeseen (tallennus estetään). */
  writable: boolean;
  /** Onko sovelluksen demotunnisteeseen perustuva potilassuodatin käytettävissä. */
  demoFilter: boolean;
  /** Nimihaun muoto: "name" (yksi parametri) tai "family-given" (sukunimi ja etunimi erikseen, esim. Epic). */
  patientNameSearch: "name" | "family-given";
  /** Observation-haku vaatii kategorian tai koodin (esim. Epic): yleishaku "kaikki havainnot" korvataan vitaali- ja laboratoriohauilla. */
  observationsNeedCategory?: boolean;
  /** Lähteen julkisesti dokumentoidut synteettiset testipotilaat; haetaan tunnisteella, tietoja ei kopioida tähän. */
  testPatients?: TestPatient[];
}

export interface TestPatient {
  label: string;
  /** `system|arvo` -tunnistehaku. */
  query: string;
}

const EPIC_MRN_SYSTEM = "urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.14";


export const DEFAULT_SOURCE_ID = "hapi";

export const SOURCES: readonly EhrSource[] = [
  {
    id: "hapi",
    label: "HAPI FHIR R4 (julkinen testipalvelin)",
    description: "Julkinen, jaettu HAPI-testipalvelin. Vain synteettistä dataa; tallennus sallittu sovelluksen demopotilaille.",
    baseUrl: "https://hapi.fhir.org/baseR4",
    baseUrlEnv: "FHIR_BASE_URL",
    auth: { kind: "none" },
    writable: true,
    demoFilter: true,
    patientNameSearch: "name",
  },
  {
    id: "epic",
    label: "Epic on FHIR (sandbox)",
    description: "Epicin avoin sandbox. SMART on FHIR -kirjautuminen (standalone launch); vain luku.",
    baseUrl: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
    auth: { kind: "smart-standalone", clientIdEnv: "EPIC_CLIENT_ID", scopes: ["openid", "fhirUser"] },
    writable: false,
    demoFilter: false,
    patientNameSearch: "family-given",
    observationsNeedCategory: true,
    // Epicin dokumentaation (fhir.epic.com, Sandbox Test Data) testipotilaat; MRN-järjestelmä on sandboxin oma.
    testPatients: [
      ["Camila Lopez", "203713"],
      ["Derrick Lin", "203711"],
      ["Desiree Powell", "203714"],
      ["Elijah Davis", "203709"],
      ["Linda Ross", "203712"],
      ["Olivia Roberts", "203715"],
      ["Warren McGinnis", "203710"],
    ].map(([label, mrn]) => ({ label, query: `${EPIC_MRN_SYSTEM}|${mrn}` })),
  },
];

export function findSource(id: string | undefined): EhrSource | undefined {
  return SOURCES.find((s) => s.id === id);
}

/** Lähteen ID:t Zod-enumia varten (vähintään yksi). */
export function sourceIds(): [string, ...string[]] {
  return SOURCES.map((s) => s.id) as [string, ...string[]];
}

/** Pyynnön lähdetunniste: vain rekisterin tunnisteet kelpaavat; puuttuva tarkoittaa oletuslähdettä. */
export const SourceIdSchema = z.enum(sourceIds()).default(DEFAULT_SOURCE_ID);

export function isWritable(sourceId: string): boolean {
  return findSource(sourceId)?.writable === true;
}

export function resolveBaseUrl(source: EhrSource, env: Record<string, string | undefined>): string {
  const raw = (source.baseUrlEnv ? env[source.baseUrlEnv] : undefined) || source.baseUrl;
  return raw.replace(/\/+$/, "");
}

/** Selaimelle kerrottava, salaisuuksia sisältämätön kuvaus lähteestä. */
export interface PublicSource {
  id: string;
  label: string;
  description: string;
  writable: boolean;
  demoFilter: boolean;
  patientNameSearch: "name" | "family-given";
  testPatients: TestPatient[];
  requiresLogin: boolean;
}

export function toPublicSource(s: EhrSource): PublicSource {
  return {
    id: s.id,
    label: s.label,
    description: s.description,
    writable: s.writable,
    demoFilter: s.demoFilter,
    patientNameSearch: s.patientNameSearch,
    testPatients: s.testPatients ?? [],
    requiresLogin: s.auth.kind !== "none",
  };
}
