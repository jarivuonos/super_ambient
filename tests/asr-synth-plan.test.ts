import { describe, expect, it } from "vitest";
import { SAMPLE_CONVERSATIONS } from "../lib/clinical/sample-conversations";
import { findReference } from "../scripts/asr/references";
import { DEFAULT_VOICES, GEMINI_VOICES, parseVoiceMap, planSummary, planTurns, turnCacheKey, turnGaps } from "../scripts/asr/synth-plan";

describe("dialogin puhesynteesin suunnittelu", () => {
  it("äänikartta: oletukset, ylikirjoitus (isoilla ja pienillä kirjaimilla), tuntematon ääni ja virheellinen muoto antavat virheen", () => {
    expect(parseVoiceMap(undefined)).toEqual(DEFAULT_VOICES);
    expect(parseVoiceMap("Potilas=aoede, Läheinen=PUCK")).toMatchObject({ Lääkäri: "Charon", Potilas: "Aoede", Läheinen: "Puck" });
    expect(() => parseVoiceMap("Potilas=Pekka")).toThrow(/Tuntematon ääni "Pekka"/);
    expect(() => parseVoiceMap("Potilas")).toThrow(/Rooli=Ääni/);
    expect(new Set(GEMINI_VOICES).size).toBe(30);
    expect(new Set(Object.values(DEFAULT_VOICES)).size).toBe(Object.keys(DEFAULT_VOICES).length);
  });

  it("tauot: puhujan vaihtuessa koko tauko, saman puhujan jatkaessa puolet, viimeisen jälkeen ei taukoa", () => {
    expect(turnGaps(["A", "B", "B", "A"], 700)).toEqual([700, 350, 700, 0]);
    expect(turnGaps(["A"], 700)).toEqual([0]);
    expect(turnGaps([], 700)).toEqual([]);
  });

  it("suunnitelma: jokaiselle vuorolle rooliaan vastaava ääni, tuntematon rooli saa oletusäänen, yhteenveto laskee sanat ja merkit", () => {
    const ref = findReference(SAMPLE_CONVERSATIONS[1].id)!;
    const turns = planTurns(ref, DEFAULT_VOICES);
    expect(turns).toHaveLength(ref.turns.length);
    for (const t of turns) expect(t.voice).toBe(DEFAULT_VOICES[t.who]);
    const odd = planTurns({ ...ref, turns: [{ who: "Sairaanhoitaja", text: "Hei" }] }, DEFAULT_VOICES);
    expect(odd[0].voice).toBe(DEFAULT_VOICES.Tuntematon);
    const sum = planSummary(turns);
    expect(sum.turns).toBe(turns.length);
    expect(sum.words).toBeGreaterThan(10);
    expect(sum.chars).toBe(turns.reduce((n, t) => n + t.text.length, 0));
  });

  it("välimuistiavain: vakaa ja herkkä mallille, äänelle, tyylille ja tekstille", () => {
    const k = turnCacheKey("m", "Kore", "", "Hei");
    expect(turnCacheKey("m", "Kore", "", "Hei")).toBe(k);
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    for (const other of [turnCacheKey("m2", "Kore", "", "Hei"), turnCacheKey("m", "Puck", "", "Hei"), turnCacheKey("m", "Kore", "slow", "Hei"), turnCacheKey("m", "Kore", "", "Hei.")]) expect(other).not.toBe(k);
  });
});
