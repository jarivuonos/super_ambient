// Mikrofonin tason laskenta (puhdas logiikka, ei selainriippuvuuksia, jotta se on testattavissa).

/** Mittarin alaraja desibeleinä täyteen asteikkoon (0 dBFS) nähden. */
export const METER_FLOOR_DB = -60;
/** Alle tämän huipputason äänite on käytännössä hiljainen (mykistetty tai väärä mikrofoni). Käyttöliittymän apuraja, ei kliininen kriteeri. */
export const SILENCE_PEAK_DB = -55;
/** Näin pitkän äänityksen jälkeen matala taso varoitetaan jo äänityksen aikana. */
export const QUIET_AFTER_MS = 3000;

/** Näytteiden tehollisarvo (RMS) välillä 0–1. Tyhjä syöte antaa 0. */
export function rmsOf(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

/** Desibeleinä täyteen asteikkoon nähden; täysi hiljaisuus rajataan arvoon -120 (ei -Infinity). */
export function toDb(rms: number): number {
  return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
}

/** Mittarin täyttöaste 0–1: METER_FLOOR_DB -> 0, 0 dB -> 1. */
export function meterLevel(db: number): number {
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

export function isEffectivelySilent(peakDb: number): boolean {
  return peakDb < SILENCE_PEAK_DB;
}
