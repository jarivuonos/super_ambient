import { describe, expect, it } from "vitest";
import { METER_FLOOR_DB, SILENCE_PEAK_DB, isEffectivelySilent, meterLevel, rmsOf, toDb } from "../lib/audio/level";

const sine = (amp: number, n = 1024) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 16 * i) / n));

describe("mikrofonin tason laskenta", () => {
  it("täysi hiljaisuus: RMS 0, -120 dB, mittari 0, äänite hiljainen", () => {
    const silent = new Float32Array(1024);
    expect(rmsOf(silent)).toBe(0);
    expect(toDb(rmsOf(silent))).toBe(-120);
    expect(meterLevel(toDb(0))).toBe(0);
    expect(isEffectivelySilent(toDb(0))).toBe(true);
  });

  it("täysi siniaalto: RMS noin 0,707 eli noin -3 dB", () => {
    const rms = rmsOf(sine(1));
    expect(rms).toBeCloseTo(Math.SQRT1_2, 3);
    expect(toDb(rms)).toBeCloseTo(-3.01, 1);
  });

  it("tyhjä syöte ei kaada laskentaa", () => {
    expect(rmsOf([])).toBe(0);
  });

  it("mittari rajautuu välille 0–1 ja kasvaa tason mukana", () => {
    expect(meterLevel(-200)).toBe(0);
    expect(meterLevel(METER_FLOOR_DB)).toBe(0);
    expect(meterLevel(0)).toBe(1);
    expect(meterLevel(10)).toBe(1);
    expect(meterLevel(-30)).toBeCloseTo(0.5, 5);
    expect(meterLevel(-20)).toBeGreaterThan(meterLevel(-40));
  });

  it("tavallinen puhetaso (noin -30 dB) ei ole hiljainen, mutta hyvin matala taso on", () => {
    expect(isEffectivelySilent(toDb(rmsOf(sine(0.04))))).toBe(false); // noin -31 dB
    expect(isEffectivelySilent(toDb(rmsOf(sine(0.0005))))).toBe(true); // noin -69 dB
  });

  it("hiljaisuuden raja on raja-arvon kohdalla tarkka", () => {
    expect(isEffectivelySilent(SILENCE_PEAK_DB)).toBe(false);
    expect(isEffectivelySilent(SILENCE_PEAK_DB - 0.01)).toBe(true);
  });
});
