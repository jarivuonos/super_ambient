import { describe, expect, it } from "vitest";
import { KINDS } from "../lib/clinical/sentence-classifier";
import { splitClauses, splitTranscript } from "../lib/clinical/sentences";
import { parsePastedTranscript } from "../lib/clinical/transcript";
import { mockStructure } from "../lib/clinical/mock-structurer";
import { finalizeStructuring } from "../lib/workflow/review";
import { GOLD, SAMPLE_CONVERSATIONS, goldTranscriptText } from "../lib/clinical/sample-conversations";

describe("rakenteistuksen kultajoukko", () => {
  it("jokainen rivi on yksi lause ja puhujaroolit tunnistetaan", () => {
    for (const g of GOLD) {
      const t = parsePastedTranscript(goldTranscriptText(g));
      const sentences = splitTranscript(t);
      expect(sentences.length, g.id).toBe(g.lines.length);
      sentences.forEach((s, i) => {
        expect(s.text, `${g.id}:${i}`).toBe(g.lines[i].text);
        expect(s.seg.speaker, `${g.id}:${i}`).not.toBe("tuntematon");
      });
    }
  });

  it("kaikki merkityt rivit löytyvät puhujan ja tekstin perusteella (eval-skriptin täsmäys)", () => {
    const speaker = { Lääkäri: "ammattilainen", Potilas: "potilas", Läheinen: "läheinen" } as const;
    for (const g of GOLD) {
      const sentences = splitTranscript(parsePastedTranscript(goldTranscriptText(g)));
      for (const l of g.lines.filter((x) => x.gold || x.clauses)) {
        expect(sentences.some((s) => s.text === l.text && s.seg.speaker === speaker[l.who]), `${g.id}: ${l.text}`).toBe(true);
      }
    }
  });

  it("yhdistelmälauseiden osat vastaavat täsmälleen sovelluksen jakoa ja jokaisella osalla on oma merkintä", () => {
    let compound = 0;
    for (const g of GOLD) {
      const sentences = splitTranscript(parsePastedTranscript(goldTranscriptText(g)));
      for (const l of g.lines) {
        expect(!!l.gold && !!l.clauses, `${g.id}: ${l.text} (gold ja clauses yhtä aikaa)`).toBe(false);
        const s = sentences.find((x) => x.text === l.text)!;
        const parts = splitClauses(s);
        if (l.clauses) {
          compound++;
          expect(parts.map((p) => p.text), `${g.id}: ${l.text}`).toEqual(l.clauses.map((c) => c.text));
          for (const c of l.clauses) {
            expect(c.gold.alt ?? []).not.toContain(c.gold.kind);
            if (c.gold.kind === "family") expect(c.gold.rel).toBe(true);
          }
        } else {
          // Merkitsemätön jako: yksittäislause ei saa jakautua huomaamatta.
          expect(parts, `${g.id}: ${l.text}`).toHaveLength(1);
        }
      }
    }
    expect(compound).toBeGreaterThanOrEqual(10);
  });

  it("on monipuolinen, mutta merkinnät ovat johdonmukaisia", () => {
    const golds = GOLD.flatMap((g) => g.lines.flatMap((l) => (l.clauses ? l.clauses.map((c) => ({ ...c.gold, text: c.text })) : l.gold ? [{ ...l.gold, text: l.text }] : [])));
    expect(GOLD).toHaveLength(13);
    expect(golds.length).toBeGreaterThanOrEqual(90);
    for (const k of KINDS) expect(golds.some((x) => x.kind === k), k).toBe(true);
    expect(golds.some((x) => x.neg)).toBe(true);
    expect(golds.some((x) => x.rel)).toBe(true);
    expect(golds.some((x) => x.hedge)).toBe(true);
    for (const x of golds) {
      expect(x.alt ?? []).not.toContain(x.kind);
      if (x.kind === "family") expect(x.rel).toBe(true);
    }
  });

  it("mock läpäisee skeemavalidoinnin kultajoukon jokaisella litteraatilla", () => {
    for (const g of GOLD) {
      const t = parsePastedTranscript(goldTranscriptText(g));
      const fin = finalizeStructuring(mockStructure(t), t);
      expect(fin.ok, g.id).toBe(true);
      expect(fin.warnings, g.id).toEqual([]);
    }
  });

  it("käyttöliittymän esimerkkivalikko: oletusesimerkki ensin, sitten kaikki kultajoukon keskustelut", () => {
    expect(SAMPLE_CONVERSATIONS[0].id).toBe("esimerkki");
    expect(SAMPLE_CONVERSATIONS).toHaveLength(GOLD.length + 1);
    expect(new Set(SAMPLE_CONVERSATIONS.map((s) => s.id)).size).toBe(SAMPLE_CONVERSATIONS.length);
    for (const s of SAMPLE_CONVERSATIONS) {
      expect(s.title.length).toBeGreaterThan(3);
      const t = parsePastedTranscript(s.text);
      expect(t.speakerSource, s.id).toBe("käyttäjän merkinnät"); // puhujaetuliitteet tunnistetaan
      expect(t.segments.every((x) => x.speaker !== "tuntematon"), s.id).toBe(true);
      expect(s.text).not.toMatch(/gold|alt:|hedge/); // merkinnät eivät vuoda litteraattiin
    }
  });
});
