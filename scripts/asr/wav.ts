// Pieni WAV-apuri puhesynteesin tuloksille: 16-bittinen mono-PCM, ei ulkoisia työkaluja (ei ffmpegiä).

export interface Wav {
  sampleRate: number;
  /** 16-bittinen little-endian mono-PCM. */
  pcm: Uint8Array;
}

const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** Lukee RIFF/WAV-tiedoston ja palauttaa PCM-datan. Hylkää muut kuin 16-bittiset mono-tiedostot. */
export function parseWav(bytes: Uint8Array): Wav {
  if (bytes.length < 12 || text(bytes, 0, 4) !== "RIFF" || text(bytes, 8, 4) !== "WAVE") throw new Error("Ääni ei ole WAV-tiedosto.");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sampleRate = 0;
  let ok = false;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = text(bytes, pos, 4);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      const format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      const bits = v.getUint16(body + 14, true);
      ok = format === 1 && channels === 1 && bits === 16;
      if (!ok) throw new Error(`Tuettu on vain 16-bittinen mono-PCM (saatiin muoto ${format}, ${channels} kanavaa, ${bits} bittiä).`);
    } else if (id === "data") {
      if (!ok) throw new Error("WAV-tiedostosta puuttuu fmt-lohko ennen dataa.");
      // Suoratoiston WAV-otsakkeessa koko voi olla 0 tai 0xFFFFFFFF: silloin data jatkuu tiedoston loppuun.
      const end = size === 0 || size === 0xffffffff || body + size > bytes.length ? bytes.length : body + size;
      return { sampleRate, pcm: bytes.subarray(body, end - ((end - body) % 2)) };
    }
    pos = body + size + (size % 2);
  }
  throw new Error("WAV-tiedostosta puuttuu datalohko.");
}

/** Raaka 16-bittinen mono-PCM WAV-tiedostoksi. */
export function buildWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export function silencePcm(ms: number, sampleRate: number): Uint8Array {
  return new Uint8Array(Math.round((ms / 1000) * sampleRate) * 2);
}

/** Liittää WAV-osat peräkkäin; `gapsMs[i]` on hiljaisuus osan i jälkeen (viimeisen perään ei lisätä). Kaikilla osilla on oltava sama näytetaajuus. */
export function joinWav(parts: Uint8Array[], gapsMs: number[]): Uint8Array {
  if (!parts.length) throw new Error("Ei liitettäviä osia.");
  const wavs = parts.map(parseWav);
  const rate = wavs[0].sampleRate;
  if (wavs.some((w) => w.sampleRate !== rate)) throw new Error("Osien näytetaajuudet eroavat.");
  const chunks: Uint8Array[] = [];
  wavs.forEach((w, i) => {
    chunks.push(w.pcm);
    if (i < wavs.length - 1) chunks.push(silencePcm(gapsMs[i] ?? 0, rate));
  });
  const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    pcm.set(c, at);
    at += c.length;
  }
  return buildWav(pcm, rate);
}

export function durationSeconds(wav: Uint8Array): number {
  const w = parseWav(wav);
  return w.pcm.length / 2 / w.sampleRate;
}
