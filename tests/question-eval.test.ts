import { describe, expect, it } from "vitest";
import { CORE_SET, EVAL_SET, HARD_SET, accepts } from "../scripts/data/question-eval-set";
import { KNOWN_INTENTS } from "../lib/clinical/intents";
import { mockInterpretQuestion } from "../lib/clinical/mock-language";
import { InfoNeedSchema } from "../lib/clinical/schemas";

describe("suomenkielinen arviointijoukko", () => {
  it("on ehjä: ei kaksoiskappaleita, kattaa kaikki tiedontarpeet ja 'none'", () => {
    const qs = EVAL_SET.map((c) => c.q.toLowerCase());
    expect(new Set(qs).size).toBe(qs.length);
    expect(CORE_SET.length).toBe(41); // perusjoukko pysyy vertailukelpoisena
    expect(HARD_SET.length).toBeGreaterThanOrEqual(30);
    expect(EVAL_SET.length).toBe(CORE_SET.length + HARD_SET.length);
    const intents = new Set(EVAL_SET.map((c) => c.intent));
    for (const i of KNOWN_INTENTS) expect(intents.has(i)).toBe(true);
    expect(intents.has("none")).toBe(true);
    expect(EVAL_SET.some((c) => c.visitOnly)).toBe(true);
    expect(EVAL_SET.some((c) => c.period === "week")).toBe(true);
    expect(EVAL_SET.some((c) => c.period === "month")).toBe(true);
    expect(EVAL_SET.some((c) => c.period === "year")).toBe(true);
  });

  it("vaikeampi joukko: hyväksytyt vaihtoehdot ovat järkeviä ja joukko monipuolinen", () => {
    for (const c of EVAL_SET) {
      expect(c.alsoAccept ?? []).not.toContain(c.intent);
      expect(accepts(c, c.intent)).toBe(true);
      if (c.alsoAccept) expect(c.tag === "ambiguous" || c.tag === "mixed").toBe(true);
    }
    const tags = new Set(HARD_SET.map((c) => c.tag));
    for (const t of ["ambiguous", "mixed", "messy", "abbreviation", "negated-scope", "injection", "multilingual", "short", "out-of-scope"] as const) expect(tags.has(t)).toBe(true);
    expect(HARD_SET.filter((c) => c.intent === "none").length).toBeGreaterThanOrEqual(6);
    expect(HARD_SET.some((c) => c.visitOnly === false && c.tag === "negated-scope")).toBe(true);
  });

  it("mock tunnistaa kanoniset esimerkkikysymykset (muut parafraasit ovat Jevin arvioitavia)", () => {
    for (const c of EVAL_SET.filter((x) => x.tag === "canonical")) {
      const need = mockInterpretQuestion(c.q, "2026-10-07");
      expect(InfoNeedSchema.safeParse(need).success).toBe(true);
      expect(need.intent).toBe(c.intent);
    }
  });
});
