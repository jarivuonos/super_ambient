import { describe, expect, it } from "vitest";
import { align, compareKeys, negationScore, numberScore, speakerScore, tokenize, wordErrorRate } from "../scripts/asr/metrics";

const run = (ref: string, hyp: string) => {
  const r = tokenize(ref);
  const h = tokenize(hyp);
  return { r, h, ops: align(r, h) };
};

describe("litteroinnin mittarit", () => {
  it("sanoittaminen: numerot pysyvät yhtenä, desimaalipilkku normalisoidaan, ääkköset säilyvät", () => {
    expect(tokenize("RR 148/92, lämpö 38,5 °C. Ääni")).toEqual(["rr", "148/92", "lämpö", "38.5", "c", "ääni"]);
    expect(tokenize("Pvm 12.5.2026")).toEqual(["pvm", "12.5.2026"]);
  });

  it("sanavirhesuhde: täsmäävä 0, pudotettu sana 1/3, korvaus ja lisäys lasketaan, tyhjä viite antaa null", () => {
    const same = run("ei ole kuumetta", "Ei ole kuumetta.");
    expect(wordErrorRate(same.ops, same.r.length, same.h.length).wer).toBe(0);

    const del = run("ei ole kuumetta", "ole kuumetta");
    const w = wordErrorRate(del.ops, del.r.length, del.h.length);
    expect(w.deletions).toBe(1);
    expect(w.wer).toBeCloseTo(1 / 3, 5);

    const mix = run("a b c d", "a x c d e");
    const m = wordErrorRate(mix.ops, mix.r.length, mix.h.length);
    expect([m.substitutions, m.insertions, m.deletions]).toEqual([1, 1, 0]);
    expect(m.wer).toBeCloseTo(2 / 4, 5);

    expect(wordErrorRate([], 0, 0).wer).toBeNull();
  });

  it("kohdistus on järjestyksen mukainen: sama sana väärässä kohdassa ei täsmää", () => {
    const { ops } = run("ei kuumetta ole", "kuumetta ei ole");
    expect(ops.filter((o) => o.op === "match").length).toBeLessThan(3);
  });

  it("kieltosanat: pudonnut 'ei' havaitaan, ja keksitty 'ei' lasketaan erikseen", () => {
    const dropped = run("hänellä ei ole kuumetta", "hänellä on kuumetta");
    const s = negationScore(dropped.r, dropped.h, dropped.ops, "fi-FI");
    expect([s.refCount, s.preserved, s.spurious]).toEqual([1, 0, 0]);

    const invented = run("hänellä on kuumetta", "hänellä ei kuumetta");
    const t = negationScore(invented.r, invented.h, invented.ops, "fi-FI");
    expect([t.refCount, t.preserved, t.spurious]).toEqual([0, 0, 1]);

    const ok = run("hänellä ei ole kuumetta", "hänellä ei ole kuumetta");
    expect(negationScore(ok.r, ok.h, ok.ops, "fi").preserved).toBe(1);
  });

  it("kieltosanat toimivat ruotsiksi", () => {
    const x = run("hon har inte feber", "hon har feber");
    const s = negationScore(x.r, x.h, x.ops, "sv-SE");
    expect([s.refCount, s.preserved]).toEqual([1, 0]);
  });

  it("numerot: yksikin väärä numero näkyy sekä puuttuvana että ylimääräisenä", () => {
    const x = run("paine 148/92 syke 78", "paine 148/82 syke 78");
    const s = numberScore(x.r, x.h, x.ops);
    expect([s.refCount, s.preserved, s.spurious]).toEqual([2, 1, 1]);
  });

  it("puhujien kohdistus: läheinen ja potilas yhdistyvät samaksi puhujaksi -> varoitus", () => {
    const refWho = ["Lääkäri", "Lääkäri", "Potilas", "Potilas", "Läheinen", "Läheinen"];
    const ops = refWho.map((_, i) => ({ op: "match" as const, ref: i, hyp: i }));
    const merged = speakerScore(refWho, ["A", "A", "B", "B", "B", "B"], ops)!;
    expect(merged.accuracy).toBeCloseTo(4 / 6, 5);
    expect(merged.patientAndRelativeMerged).toBe(true);
    expect(merged.relativeAsPatientRate).toBe(1);

    const perfect = speakerScore(refWho, ["A", "A", "B", "B", "C", "C"], ops)!;
    expect(perfect.accuracy).toBe(1);
    expect(perfect.patientAndRelativeMerged).toBe(false);
    expect(perfect.relativeAsPatientRate).toBe(0);
    expect(perfect.mapping).toEqual({ A: "Lääkäri", B: "Potilas", C: "Läheinen" });
  });

  it("puhujien kohdistus: ylijaettu puhuja (kaksi tunnistettua samalle roolille) ei ole virhe; puuttuva puhujatieto antaa null", () => {
    const refWho = ["Lääkäri", "Lääkäri", "Potilas", "Potilas"];
    const ops = refWho.map((_, i) => ({ op: "match" as const, ref: i, hyp: i }));
    expect(speakerScore(refWho, ["A", "B", "C", "C"], ops)!.accuracy).toBe(1);
    expect(speakerScore(refWho, [undefined, undefined, undefined, undefined], ops)).toBeNull();
  });

  it("ehdotusten vertailu: puuttuvat, ylimääräiset ja ylimääräiset kohteelliset erikseen", () => {
    const a = compareKeys(["Observation|bp|potilas|pos|x", "-|symptom|potilas|pos|y"], ["Observation|bp|potilas|pos|x", "Condition|condition|potilas|pos|z"]);
    expect(a.recall).toBe(0.5);
    expect(a.precision).toBe(0.5);
    expect(a.missing).toEqual(["-|symptom|potilas|pos|y"]);
    expect(a.extra).toEqual(["Condition|condition|potilas|pos|z"]);
    expect(a.extraTargets).toBe(1);
    expect(compareKeys([], []).recall).toBeNull();
  });
});
