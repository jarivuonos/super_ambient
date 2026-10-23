import { describe, expect, it } from "vitest";
import { buildWav, durationSeconds, joinWav, parseWav, silencePcm } from "../scripts/asr/wav";

const RATE = 24000;
/** `ms` millisekuntia nollasta poikkeavaa PCM-ääntä (vakioarvo 1000), jotta hiljaisuus erottuu. */
const tone = (ms: number, value = 1000) => {
  const n = Math.round((ms / 1000) * RATE);
  const pcm = new Uint8Array(n * 2);
  const v = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, value, true);
  return pcm;
};

describe("WAV-apuri", () => {
  it("rakentaminen ja jäsennys ovat toistensa käänteisiä; kesto lasketaan datasta", () => {
    const wav = buildWav(tone(500), RATE);
    const w = parseWav(wav);
    expect(w.sampleRate).toBe(RATE);
    expect(w.pcm.length).toBe(RATE); // 0,5 s * 24000 * 2 tavua
    expect(durationSeconds(wav)).toBeCloseTo(0.5, 5);
  });

  it("liittäminen: kesto on osien summa plus tauot, viimeisen perään ei lisätä taukoa, tauko on hiljaisuutta", () => {
    const a = buildWav(tone(1000), RATE);
    const b = buildWav(tone(500), RATE);
    const c = buildWav(tone(250), RATE);
    const joined = joinWav([a, b, c], [300, 100, 9999]);
    expect(durationSeconds(joined)).toBeCloseTo(1 + 0.3 + 0.5 + 0.1 + 0.25, 4);
    const pcm = parseWav(joined).pcm;
    const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const at = (sec: number) => v.getInt16(Math.round(sec * RATE) * 2, true);
    expect(at(0.5)).toBe(1000); // ensimmäisen osan sisällä
    expect(at(1.1)).toBe(0); // ensimmäisen tauon sisällä
    expect(at(1.4)).toBe(1000); // toisen osan sisällä
    expect(silencePcm(100, RATE).every((x) => x === 0)).toBe(true);
  });

  it("hylkää muun kuin WAVin, stereon, muun bittisyvyyden ja eri näytetaajuudet", () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3]))).toThrow(/ei ole WAV/);
    const stereo = buildWav(tone(10), RATE);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => parseWav(stereo)).toThrow(/16-bittinen mono/);
    const bits8 = buildWav(tone(10), RATE);
    new DataView(bits8.buffer).setUint16(34, 8, true);
    expect(() => parseWav(bits8)).toThrow(/16-bittinen mono/);
    expect(() => joinWav([buildWav(tone(10), RATE), buildWav(tone(10), 16000)], [0])).toThrow(/näytetaajuudet/);
    expect(() => joinWav([], [])).toThrow(/Ei liitettäviä/);
  });

  it("suoratoiston otsake (datan koko 0 tai 0xFFFFFFFF) luetaan tiedoston loppuun asti", () => {
    for (const size of [0, 0xffffffff]) {
      const wav = buildWav(tone(100), RATE);
      new DataView(wav.buffer).setUint32(40, size, true);
      expect(parseWav(wav).pcm.length).toBe(tone(100).length);
    }
  });

  it("kokonaislukunäytteiden tavuparia vaille jäävä pyrstö pudotetaan", () => {
    const wav = buildWav(tone(10), RATE);
    const odd = new Uint8Array(wav.length + 1);
    odd.set(wav);
    new DataView(odd.buffer).setUint32(40, 0, true);
    expect(parseWav(odd).pcm.length % 2).toBe(0);
  });
});
