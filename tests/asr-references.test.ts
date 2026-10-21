import { describe, expect, it } from "vitest";
import { SAMPLE_CONVERSATIONS } from "../lib/clinical/sample-conversations";
import type { AsrResult } from "../scripts/asr/gemini";
import { findReference, idFromFileBase, parseReferenceText, referenceText } from "../scripts/asr/references";
import { labelledHypothesis, scoreTranscript } from "../scripts/asr/score";

describe("viitelitteraatit", () => {
  it("rivit jäsentyvät rooleiksi; roolitta jatkuva rivi liitetään edelliseen, ensimmäinen roolitta on tuntematon", () => {
    expect(parseReferenceText("Lääkäri: Mikä tuo tänään?\nPotilas: Vatsakipu\njatkuu täällä\nLäheinen: Hän ei syö.")).toEqual([
      { who: "Lääkäri", text: "Mikä tuo tänään?" },
      { who: "Potilas", text: "Vatsakipu jatkuu täällä" },
      { who: "Läheinen", text: "Hän ei syö." },
    ]);
    expect(parseReferenceText("pelkkää tekstiä")[0].who).toBe("Tuntematon");
  });

  it("tiedostonimi: kielietuliite sallitaan, esimerkin tunniste löytyy, tuntematon ei", () => {
    const id = SAMPLE_CONVERSATIONS[1].id;
    expect(idFromFileBase(`fi-${id}`)).toBe(id);
    expect(idFromFileBase(`sv_${id}`)).toBe(id);
    expect(findReference(`fi-${id}`)?.id).toBe(id);
    expect(findReference(id)?.source).toBe("esimerkki");
    expect(findReference("jokin-muu")).toBeNull();
  });

  it("sivutiedosto ohittaa esimerkin", () => {
    const r = findReference(SAMPLE_CONVERSATIONS[1].id, "Lääkäri: Hei\nPotilas: Moi");
    expect(r?.source).toBe("sivutiedosto");
    expect(r?.turns).toHaveLength(2);
  });
});

/** Täydellinen litteraatti: viitteen sanat puhujarooleineen, kuten palvelu ne parhaimmillaan palauttaisi. */
function perfect(id: string): AsrResult {
  const ref = findReference(id)!;
  const words = ref.turns.flatMap((t) => t.text.split(/\s+/).filter(Boolean).map((w) => ({ text: w, speaker: t.who })));
  return { text: words.map((w) => w.text).join(" "), words, raw: {} };
}

describe("yhden tiedoston pisteytys", () => {
  const withNeg = SAMPLE_CONVERSATIONS.find((s) => /\bei\b/iu.test(s.text) && s.text.includes("Läheinen"))!;

  it("täydellinen litteraatti: virhe 0, puhujat oikein, ehdotukset samat, ei ylimääräisiä kohteita", () => {
    const ref = findReference(withNeg.id)!;
    const s = scoreTranscript(ref, perfect(withNeg.id), "fi-FI");
    expect(s.wer.wer).toBe(0);
    expect(s.speakers?.accuracy).toBe(1);
    expect(s.speakers?.patientAndRelativeMerged).toBe(false);
    expect(s.negations.refCount).toBeGreaterThan(0);
    expect(s.negations.preserved).toBe(s.negations.refCount);
    expect(s.agreement.recall).toBe(1);
    expect(s.agreement.precision).toBe(1);
    expect(s.agreement.extraTargets).toBe(0);
  });

  it("kaikki 'ei'-sanat pudonneet: kieltosanat eivät säily, ja virhe näkyy sanavirheessä", () => {
    const ref = findReference(withNeg.id)!;
    const p = perfect(withNeg.id);
    const words = p.words.filter((w) => !/^ei[.,!?]?$/iu.test(w.text));
    const s = scoreTranscript(ref, { text: words.map((w) => w.text).join(" "), words, raw: {} }, "fi-FI");
    expect(s.negations.preserved).toBeLessThan(s.negations.refCount);
    expect(s.wer.wer).toBeGreaterThan(0);
  });

  it("ilman puhujatietoa puhujapisteet ovat null, mutta sanavirhe lasketaan tekstistä", () => {
    const ref = findReference(withNeg.id)!;
    const text = perfect(withNeg.id).text;
    const s = scoreTranscript(ref, { text, words: [], raw: {} }, "fi-FI");
    expect(s.speakers).toBeNull();
    expect(s.wer.wer).toBe(0);
  });

  it("puhujamerkityt rivit rakennetaan roolinimillä, kun vastaavuus on tiedossa", () => {
    const r: AsrResult = { text: "a b c", words: [{ text: "a", speaker: "spk_1" }, { text: "b", speaker: "spk_1" }, { text: "c", speaker: "spk_2" }], raw: {} };
    expect(labelledHypothesis(r, { spk_1: "Lääkäri", spk_2: "Potilas" })).toBe("Lääkäri: a b\nPotilas: c");
    expect(labelledHypothesis(r, undefined)).toBe("a b c");
    expect(referenceText(findReference(withNeg.id)!).startsWith(`${findReference(withNeg.id)!.turns[0].who}:`)).toBe(true);
  });
});
