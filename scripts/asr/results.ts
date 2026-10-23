// Tallennettujen koeajotulosten lukeminen uudelleenpisteytystä varten (--rescore). Ei verkkoa.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AsrResult } from "./gemini";

export interface SavedRun {
  file: string;
  mode: string;
  language: string;
  model: string;
  requestSeconds: number;
  error: string | null;
  result: AsrResult | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lukee tulosten kansion `<nimi>.<tila>.json`-tiedostot (ei summary.json) ja ohittaa muodoltaan vääränlaiset. */
export function loadRuns(dir: string): SavedRun[] {
  const runs: SavedRun[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || f === "summary.json") continue;
    let j: unknown;
    try {
      j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!isObj(j) || typeof j.file !== "string" || typeof j.mode !== "string") continue;
    const r = isObj(j.result) && typeof j.result.text === "string" && Array.isArray(j.result.words) ? (j.result as unknown as AsrResult) : null;
    runs.push({
      file: j.file,
      mode: j.mode,
      language: typeof j.language === "string" ? j.language : "fi-FI",
      model: typeof j.model === "string" ? j.model : "",
      requestSeconds: typeof j.requestSeconds === "number" ? j.requestSeconds : 0,
      error: typeof j.error === "string" ? j.error : null,
      result: r,
    });
  }
  return runs;
}
