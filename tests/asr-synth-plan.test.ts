import { describe, expect, it } from "vitest";
import { SAMPLE_CONVERSATIONS } from "../lib/clinical/sample-conversations";
import { findReference } from "../scripts/asr/references";
import { DEFAULT_VOICES, GEMINI_VOICES, mergeSameSpeaker, parseVoiceMap, planSummary, planTurns, turnCacheKey, turnGaps } from "../scripts/asr/synth-plan";

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

describe("saman puhujan vuorojen yhdistäminen", () => {
  const T = (who: string, voice: string, text: string) => ({ who, voice, text });

  it("peräkkäiset saman puhujan vuorot yhdistyvät välilyönnillä, puhujan vaihtuessa uusi pyyntö; alkuperäistä ei muuteta", () => {
    const input = [T("L", "Charon", "Hei."), T("P", "Kore", "A."), T("P", "Kore", "B."), T("P", "Kore", "C."), T("L", "Charon", "D."), T("L", "Charon", "E.")];
    const copy = JSON.parse(JSON.stringify(input));
    const m = mergeSameSpeaker(input);
    expect(m.map((t) => `${t.who}:${t.text}`)).toEqual(["L:Hei.", "P:A. B. C.", "L:D. E."]);
    expect(input).toEqual(copy);
    expect(mergeSameSpeaker([])).toEqual([]);
  });

  it("sama rooli eri äänellä ei yhdisty; oikea esimerkki pienenee, ja kaikki sanat säilyvät", () => {
    expect(mergeSameSpeaker([T("P", "Kore", "a"), T("P", "Aoede", "b")])).toHaveLength(2);
    const ref = findReference("t01")!;
    const turns = planTurns(ref, DEFAULT_VOICES);
    const merged = mergeSameSpeaker(turns);
    expect(merged.length).toBeLessThan(turns.length);
    expect(planSummary(merged).words).toBe(planSummary(turns).words);
    for (let i = 1; i < merged.length; i++) expect(merged[i].who).not.toBe(merged[i - 1].who);
  });
});
