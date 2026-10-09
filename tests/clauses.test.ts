import { describe, expect, it } from "vitest";
import { splitClauses, splitTranscript, splitUnits } from "../lib/clinical/sentences";
import { parsePastedTranscript } from "../lib/clinical/transcript";

const clausesOf = (text: string) => {
  const t = parsePastedTranscript(`Potilas: ${text}`);
  return splitTranscript(t).flatMap(splitClauses);
};

describe("lauseiden jako osiin", () => {
  it("jakaa 'mutta'-erottimesta ja säilyttää tarkat merkkikohdat puheenvuorossa", () => {
    const t = parsePastedTranscript("Potilas: Pahoinvointia on ollut, mutta en ole oksentanut.");
    const units = splitUnits(t);
    expect(units.map((u) => u.text)).toEqual(["Pahoinvointia on ollut", "en ole oksentanut."]);
    for (const u of units) {
      expect(u.seg.text.slice(u.start, u.end)).toBe(u.text);
      expect(u.parent?.text).toBe("Pahoinvointia on ollut, mutta en ole oksentanut.");
    }
    expect(units.map((u) => u.clauseIndex)).toEqual([0, 1]);
  });

  it("jakaa myös puolipisteestä ja 'vaikka'-sanasta; kolme osaa onnistuu", () => {
    expect(clausesOf("Yskä on kuivaa; hengenahdistusta ei ole.").map((c) => c.text)).toEqual(["Yskä on kuivaa", "hengenahdistusta ei ole."]);
    expect(clausesOf("Käytän lääkettä vaikka oireet ovat lieviä.").map((c) => c.text)).toEqual(["Käytän lääkettä", "oireet ovat lieviä."]);
    expect(clausesOf("Päätä särkee, mutta kuumetta ei ole; yskää ei ole.")).toHaveLength(3);
  });

  it("ei jaa, kun osa jäisi liian lyhyeksi tai erotin on lauseen alussa tai sana on sanan osa", () => {
    expect(clausesOf("Päätä särkee, mutta ei.")).toHaveLength(1);
    expect(clausesOf("Mutta päätä särkee kovasti.")).toHaveLength(1);
    expect(clausesOf("Kipu on kauhea, muttaa ei ole.")).toHaveLength(1);
    expect(clausesOf("Päätä särkee ja yskittää.")).toHaveLength(1); // 'ja' ei ole erotin
  });

  it("kysymyksiä ei jaeta; jakamaton lause palautuu sellaisenaan ilman parent-viitettä", () => {
    const q = clausesOf("Onko ollut kuumetta, mutta ei yskää?");
    expect(q).toHaveLength(1);
    const plain = clausesOf("Päätä särkee.");
    expect(plain[0].parent).toBeUndefined();
  });
});
