import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuns } from "../scripts/asr/results";

const dir = mkdtempSync(join(tmpdir(), "asr-results-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("tallennettujen tulosten luku", () => {
  it("lukee onnistuneen ja epäonnistuneen ajon, ohittaa summary.json:n, rikkinäisen JSONin ja vieraan muodon", () => {
    writeFileSync(join(dir, "a.plain.json"), JSON.stringify({ file: "a", mode: "plain", language: "sv-SE", model: "m", requestSeconds: 12.5, error: null, result: { text: "hej", words: [{ text: "hej" }], raw: {} } }));
    writeFileSync(join(dir, "b.diarize.json"), JSON.stringify({ file: "b", mode: "diarize", error: "HTTP 503: kiire", result: null }));
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ file: "x", mode: "plain" }));
    writeFileSync(join(dir, "c.plain.json"), "{ ei json");
    writeFileSync(join(dir, "d.plain.json"), JSON.stringify({ hello: "world" }));
    writeFileSync(join(dir, "e.plain.json"), JSON.stringify({ file: "e", mode: "plain", result: { text: 5 } }));

    const runs = loadRuns(dir);
    expect(runs.map((r) => `${r.file}.${r.mode}`)).toEqual(["a.plain", "b.diarize", "e.plain"]);
    expect(runs[0]).toMatchObject({ language: "sv-SE", model: "m", requestSeconds: 12.5, error: null });
    expect(runs[0].result?.text).toBe("hej");
    expect(runs[1]).toMatchObject({ language: "fi-FI", error: "HTTP 503: kiire", result: null });
    expect(runs[2].result).toBeNull();
  });
});
