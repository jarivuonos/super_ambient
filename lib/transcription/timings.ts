import type { StageTimings } from "./gemini-client";

const fmt = (ms: number) => {
  const s = ms / 1000;
  return `${(s < 10 ? s.toFixed(1) : Math.round(s).toString()).replace(".", ",")} s`;
};

/**
 * Litteroinnin vaiheiden kestot yhtenä suomenkielisenä rivinä. `audioSeconds` on äänityksen pituus: sen avulla näytetään,
 * montako kertaa reaaliaikaa Googlen käsittely vei (ilman uusintojen odotuksia, jotka eivät ole käsittelyaikaa).
 */
export function formatTimings(t: StageTimings, audioSeconds?: number): string {
  const request = t.transcribeMs - t.retryWaitMs;
  const parts = [`lataus ${fmt(t.uploadMs)}`, `tiedoston valmistelu ${fmt(t.activeMs)}`, `litterointipyyntö ${fmt(t.transcribeMs)}`];
  if (t.retries > 0) parts[2] += ` (josta uusintojen odotusta ${fmt(t.retryWaitMs)}, ${t.retries} uusintaa)`;
  parts.push(`poisto ${fmt(t.deleteMs)}`);
  let line = `Kesto yhteensä ${fmt(t.totalMs)}: ${parts.join(" · ")}.`;
  const attempts = t.attempts ?? []; // vanhempi palvelin ei vielä lähetä yrityksiä
  if (attempts.length > 1) {
    const what = (status: number) => (status === 0 ? "yhteysvirhe" : status >= 200 && status < 300 ? "onnistui" : `HTTP ${status}`);
    line += ` Yritykset: ${attempts.map((a, i) => `${i + 1}) ${what(a.status)}, ${fmt(a.ms)}`).join("; ")}.`;
  }
  if (t.thoughtTokens !== undefined) {
    line += ` Malli käytti ${t.thoughtTokens} ajattelutokenia${t.outputTokens !== undefined ? ` (vastaus ${t.outputTokens} tokenia)` : ""}.`;
  }
  if (audioSeconds && audioSeconds > 0 && request > 0) {
    line += ` Äänite ${fmt(audioSeconds * 1000)}: käsittely noin ${(request / 1000 / audioSeconds).toFixed(1).replace(".", ",")} × reaaliaika (ilman odotuksia).`;
  }
  return line;
}
