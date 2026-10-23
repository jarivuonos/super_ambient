import { describe, expect, it } from "vitest";
import type { StageTimings } from "../lib/transcription/gemini-client";
import { formatTimings } from "../lib/transcription/timings";

const t = (over: Partial<StageTimings> = {}): StageTimings => ({ attempts: [], audioBytes: 1_000_000, uploadMs: 2300, activeMs: 900, transcribeMs: 131_000, deleteMs: 400, totalMs: 134_600, retryWaitMs: 0, retries: 0, ...over });

describe("vaiheiden kestojen esitys", () => {
  it("näyttää jokaisen vaiheen suomeksi: alle 10 s yhdellä desimaalilla (pilkku), muuten kokonaisina sekunteina", () => {
    const s = formatTimings(t());
    expect(s).toContain("Kesto yhteensä 135 s");
    expect(s).toContain("lataus 2,3 s");
    expect(s).toContain("tiedoston valmistelu 0,9 s");
    expect(s).toContain("litterointipyyntö 131 s");
    expect(s).toContain("poisto 0,4 s");
    expect(s).not.toContain("uusinta");
  });

  it("uusinnat: odotus ja määrä näkyvät litterointipyynnön yhteydessä, ja suhde reaaliaikaan lasketaan ilman odotuksia", () => {
    const s = formatTimings(t({ transcribeMs: 191_000, retryWaitMs: 60_000, retries: 2 }), 65.5);
    expect(s).toContain("josta uusintojen odotusta 60 s, 2 uusintaa");
    // (191 - 60) s / 65,5 s = 2,0
    expect(s).toContain("Äänite 66 s: käsittely noin 2,0 × reaaliaika (ilman odotuksia)");
  });

  it("ilman äänen pituutta tai ilman pyyntöaikaa ei näytetä suhdetta; virheen jälkeinen rivi (vain lataus) toimii", () => {
    expect(formatTimings(t())).not.toContain("reaaliaika");
    expect(formatTimings(t(), 0)).not.toContain("reaaliaika");
    const failed = formatTimings(t({ activeMs: 0, transcribeMs: 0, deleteMs: 0, uploadMs: 1200, totalMs: 1200 }), 30);
    expect(failed).toContain("lataus 1,2 s");
    expect(failed).not.toContain("reaaliaika");
  });
});

describe("yritykset ja ajattelutokenit tulosrivillä", () => {
  it("useampi yritys: jokainen näkyy tilanteineen ja kestoineen; yksi yritys ei lisää riviä", () => {
    const s = formatTimings(t({ attempts: [{ status: 503, ms: 95_000 }, { status: 0, ms: 2000 }, { status: 200, ms: 93_000 }], retries: 2, retryWaitMs: 60_000 }));
    expect(s).toContain("Yritykset: 1) HTTP 503, 95 s; 2) yhteysvirhe, 2,0 s; 3) onnistui, 93 s.");
    expect(formatTimings(t({ attempts: [{ status: 200, ms: 40_000 }] }))).not.toContain("Yritykset");
  });

  it("ajattelutokenit näytetään, kun ne tunnetaan, ja vastauksen tokenit niiden vieressä", () => {
    expect(formatTimings(t({ thoughtTokens: 1633, outputTokens: 169 }))).toContain("Malli käytti 1633 ajattelutokenia (vastaus 169 tokenia).");
    expect(formatTimings(t({ thoughtTokens: 0 }))).toContain("Malli käytti 0 ajattelutokenia.");
    expect(formatTimings(t())).not.toContain("ajattelutokenia");
  });
});

describe("vanhan muotoinen mittaus", () => {
  it("puuttuva yrityslista ei kaada esitystä", () => {
    const old = { audioBytes: 1, uploadMs: 1000, activeMs: 100, transcribeMs: 5000, deleteMs: 100, totalMs: 6200, retryWaitMs: 0, retries: 0 } as unknown as StageTimings;
    expect(formatTimings(old)).toContain("Kesto yhteensä 6,2 s");
  });
});
