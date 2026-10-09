import { describe, expect, it } from "vitest";
import { JevLanguageAdapter, UnavailableLanguageAdapter, createLanguageAdapter } from "../lib/clinical/language-adapter";
import { DEFAULT_JEV_ENDPOINT, DEFAULT_JEV_MODEL, readJevSettings } from "../lib/jev-settings";

describe("Jev-asetukset", () => {
  it("oletukset ja avaimen luku (TYPESAFE_API_KEY ensisijainen)", () => {
    const r = readJevSettings({ TYPESAFE_API_KEY: "a", LLM_API_KEY: "b" });
    expect(r.ok && r.settings).toEqual({ apiKey: "a", endpoint: DEFAULT_JEV_ENDPOINT, model: DEFAULT_JEV_MODEL });
    const fb = readJevSettings({ LLM_API_KEY: "b", LLM_MODEL: "jev-1.13.0" });
    expect(fb.ok && fb.settings.apiKey).toBe("b");
    expect(fb.ok && fb.settings.model).toBe("jev-1.13.0");
  });

  it("puuttuva avain, ei-https, tunnukset ja virheellinen osoite hylätään ilman avaimen paljastamista", () => {
    expect(readJevSettings({}).ok).toBe(false);
    for (const endpoint of ["http://api.example.test/v1", "https://user:pw@api.example.test/v1", "ei-osoite"]) {
      const r = readJevSettings({ TYPESAFE_API_KEY: "SECRET", LLM_ENDPOINT: endpoint });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("SECRET");
    }
  });

  it("tehdas: jev ilman asetuksia → ei käytössä (ei arvailua); asetuksilla → hybridi", () => {
    const missing = createLanguageAdapter({ provider: "jev" }, readJevSettings({}));
    expect(missing).toBeInstanceOf(UnavailableLanguageAdapter);
    expect(missing.capabilities).toEqual({ interpretQuestion: "unavailable", answer: "unavailable", structureTranscript: "unavailable" });
    const ok = createLanguageAdapter({ provider: "jev" }, readJevSettings({ TYPESAFE_API_KEY: "k" }));
    expect(ok).toBeInstanceOf(JevLanguageAdapter);
    expect(ok.kind).toBe("hybrid");
    expect(ok.capabilities).toEqual({ interpretQuestion: "model", answer: "deterministic", structureTranscript: "mock" });
    expect(createLanguageAdapter({ provider: "mock" }).capabilities.interpretQuestion).toBe("mock");
  });
});
