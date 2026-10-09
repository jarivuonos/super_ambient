import { describe, expect, it } from "vitest";
import { JevError, type JevResponse } from "../lib/clinical/jev-client";
import { KINDS, KIND_CRITERIA, TIMINGS, buildSentenceQuestions, buildSentenceState, judgementFromResponse } from "../lib/clinical/sentence-classifier";
import { splitTranscript, splitUnits } from "../lib/clinical/sentences";
import { parsePastedTranscript } from "../lib/clinical/transcript";
import { judgeResponse } from "./jev-scripted";

describe("lauseluokittelun kysymykset", () => {
  it("vaihtoehdot vastaavat sovelluksen tyyppejä ja rajoja", () => {
    const q = buildSentenceQuestions();
    expect(Object.keys(q).sort()).toEqual(["hedged", "kind", "negated", "relative", "timing"]);
    expect(Object.keys(q.kind.criteria!).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(KIND_CRITERIA).length).toBeLessThanOrEqual(255);
    expect(Object.keys(q.timing.criteria!).sort()).toEqual([...TIMINGS].sort());
    for (const k of ["negated", "relative", "hedged"]) expect(q[k].type).toBe("noul");
    for (const k of Object.keys(q)) expect(q[k].instructions).toMatch(/Judge only the field 'sentence'/);
  });

  it("tila sisältää lauseen, roolin ja kaksi edellistä puheenvuoroa – ei tunnisteita", () => {
    const t = parsePastedTranscript("Lääkäri: Alku.\nPotilas: Kysymys?\nLääkäri: Onko ollut kuumetta?\nPotilas: Ei ole kuumetta. Yskää on.");
    const s = splitTranscript(t).find((x) => x.text === "Yskää on.")!;
    const st = buildSentenceState(t, s);
    expect(st.sentence).toBe("Yskää on.");
    expect(st.speaker).toBe("patient");
    expect(st.turn).toBe("Ei ole kuumetta. Yskää on."); // lause on osa pidempää puheenvuoroa
    expect(st.previous_turns).toEqual([
      { speaker: "patient", text: "Kysymys?" },
      { speaker: "clinician", text: "Onko ollut kuumetta?" },
    ]);
    expect(JSON.stringify(st)).not.toMatch(/"id"|segmentId|s\d+|version/);
  });

  it("lauseen osalle annetaan koko lause kontekstiksi, arvioitava kenttä on vain osa", () => {
    const t = parsePastedTranscript("Potilas: Pahoinvointia on ollut, mutta en ole oksentanut.");
    const [, second] = splitUnits(t);
    const st = buildSentenceState(t, second);
    expect(st.sentence).toBe("en ole oksentanut.");
    expect(st.full_sentence).toBe("Pahoinvointia on ollut, mutta en ole oksentanut.");
    expect(st.speaker).toBe("patient");
  });

  it("puheenvuoro-kenttää ei lisätä, kun puheenvuoro on yksi lause", () => {
    const t = parsePastedTranscript("Potilas: Päätä särkee.");
    const st = buildSentenceState(t, splitTranscript(t)[0]);
    expect(st).toEqual({ previous_turns: [], speaker: "patient", sentence: "Päätä särkee." });
  });
});

describe("Jevin vastaus → arvio", () => {
  it("jäsentää kelvollisen vastauksen", () => {
    const j = judgementFromResponse(judgeResponse({ kind: "symptom", kindP: 0.9, negated: 0.97, relative: 0.02, hedged: 0.1, timing: "past", timingP: 0.8 }));
    expect(j).toEqual({ kind: "symptom", kindP: 0.9, negated: 0.97, relative: 0.02, hedged: 0.1, timing: "past", timingP: 0.8 });
  });

  it("odottamaton vastaus on virhe, ei arvaus", () => {
    const ok = judgeResponse();
    const bad = [
      { ...ok, answers: { ...ok.answers, kind: { type: "choice" as const, choice: "diagnose-everything", probabilities: { x: 1 } } } },
      { ...ok, answers: { ...ok.answers, timing: { type: "choice" as const, choice: "someday" } } },
      { ...ok, answers: { ...ok.answers, negated: { type: "choice" as const, choice: "yes" } } },
      { ...ok, answers: { kind: ok.answers.kind, negated: ok.answers.negated } },
    ];
    for (const r of bad) expect(() => judgementFromResponse(r as unknown as JevResponse)).toThrow(JevError);
  });
});
