import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_ID, SOURCES, SourceIdSchema, findSource, isWritable, resolveBaseUrl, sourceIds, toPublicSource } from "@/lib/fhir/sources";

describe("FHIR-lähteiden rekisteri", () => {
  it("oletuslähde on rekisterissä ja tunnisteet ovat yksilölliset", () => {
    expect(findSource(DEFAULT_SOURCE_ID)).toBeDefined();
    expect(new Set(sourceIds()).size).toBe(SOURCES.length);
  });

  it("tuntematon tunniste ei löydy", () => {
    expect(findSource("evil")).toBeUndefined();
    expect(findSource(undefined)).toBeUndefined();
  });

  it("osoite tulee rekisteristä; ympäristömuuttuja ohittaa oletuksen ja loppukauttaviiva poistuu", () => {
    const hapi = findSource("hapi")!;
    expect(resolveBaseUrl(hapi, {})).toBe("https://hapi.fhir.org/baseR4");
    expect(resolveBaseUrl(hapi, { FHIR_BASE_URL: "http://localhost:8080/fhir/" })).toBe("http://localhost:8080/fhir");
  });

  it("selaimelle meneva kuvaus ei sisällä osoitetta, asiakastunnusta eikä ympäristömuuttujien nimiä", () => {
    for (const s of SOURCES) {
      const json = JSON.stringify(toPublicSource(s));
      expect(json).not.toContain(s.baseUrl);
      expect(json).not.toMatch(/clientId|Env/);
    }
  });
});

describe("pyynnön lähdetunniste", () => {
  it("puuttuva tunniste tarkoittaa oletuslähdettä, tuntematon hylätään", () => {
    expect(SourceIdSchema.parse(undefined)).toBe(DEFAULT_SOURCE_ID);
    expect(SourceIdSchema.safeParse("https://evil.example/fhir").success).toBe(false);
    expect(SourceIdSchema.safeParse("").success).toBe(false);
  });

  it("kirjoitus sallitaan vain rekisterissä kirjoitettavaksi merkitylle lähteelle", () => {
    expect(isWritable("hapi")).toBe(true);
    expect(isWritable("tuntematon")).toBe(false);
  });

  it("tallennuspyyntö hylkää tuntemattoman lähteen ja täyttää oletuksen", async () => {
    const { SaveRequestSchema } = await import("@/lib/workflow/save");
    const { parsePastedTranscript } = await import("@/lib/clinical/transcript");
    const base = {
      patientId: "p1",
      encounterId: "e1",
      transcript: parsePastedTranscript("Lääkäri: RR 148/92."),
      note: null,
      proposals: [],
      createdAt: "2026-10-07T10:00:00.000Z",
    };
    expect(SaveRequestSchema.safeParse({ ...base, sourceId: "x" }).success).toBe(false);
    const ok = SaveRequestSchema.safeParse(base);
    expect(ok.success && ok.data.sourceId).toBe(DEFAULT_SOURCE_ID);
  });
});

describe("lähteen testipotilaat", () => {
  it("jokainen on system|arvo-tunnistehaku ja selaimelle välitetään vain nimi ja haku", () => {
    for (const s of SOURCES) {
      const pub = toPublicSource(s);
      for (const t of pub.testPatients) expect(t.query).toMatch(/^[^|\s]+\|[A-Za-z0-9\-.]+$/);
      expect(pub.testPatients.length).toBe((s.testPatients ?? []).length);
    }
    expect(toPublicSource(findSource("hapi")!).testPatients).toEqual([]);
  });
});
