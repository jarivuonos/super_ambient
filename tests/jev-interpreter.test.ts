import { describe, expect, it, vi } from "vitest";
import { runAsk } from "../lib/clinical/ask";
import { INTENT_PROFILE, KNOWN_INTENTS, PERIODS, daysAgo } from "../lib/clinical/intents";
import { JevClient, JevError, type JevResponse } from "../lib/clinical/jev-client";
import { JevLanguageAdapter, LanguageServiceUnavailable } from "../lib/clinical/language-adapter";
import { THRESHOLDS, buildQuestions, interpretWithJev, toInfoNeed, type InterpretDiagnostics } from "../lib/clinical/jev-interpreter";
import { InfoNeedSchema } from "../lib/clinical/schemas";
import { mockStructure } from "../lib/clinical/mock-structurer";
import { parsePastedTranscript } from "../lib/clinical/transcript";
import { setup } from "./helpers";

const TODAY = "2026-10-07";

function resp(o: { intent?: string; p?: number; conf?: number; visit?: number; period?: string; periodP?: number } = {}): JevResponse {
  const intent = o.intent ?? "blood-pressure";
  const p = o.p ?? 0.95;
  return {
    model: "jev-1.13.0",
    answers: {
      intent: { type: "choice", choice: intent, probabilities: { [intent]: p, other: 1 - p }, confidence: o.conf ?? p },
      visit_only: { type: "noul", noul: o.visit ?? 0.05 },
      period: { type: "choice", choice: o.period ?? "none", probabilities: { [o.period ?? "none"]: o.periodP ?? 0.95 }, confidence: o.periodP ?? 0.95 },
    },
    usage: { input_tokens: 300, output_tokens: 30 },
  };
}

describe("kysymykset Jevillä", () => {
  it("'none'-kriteeri kattaa kirjoituspyynnöt ja tukemattomat tietolajit; overview ei ole kaikenkattava", () => {
    const none = buildQuestions().intent.criteria!.none;
    for (const word of ["delete", "edit", "order", "vaccinations", "billing", "prognosis"]) expect(none).toContain(word);
    expect(buildQuestions().intent.criteria!.overview).not.toMatch(/how is the patient doing/);
  });

  it("kriteerit vastaavat sovelluksen tiedontarpeita ja rajoja", () => {
    const q = buildQuestions();
    expect(Object.keys(q.intent.criteria!).sort()).toEqual([...KNOWN_INTENTS, "none"].sort());
    expect(Object.keys(q.intent.criteria!).length).toBeLessThanOrEqual(255);
    expect(Object.keys(q.period.criteria!).sort()).toEqual([...PERIODS].sort());
    expect(q.visit_only.type).toBe("noul");
  });
});

describe("Jev-vastaus → tiedontarve", () => {
  it("varma tulkinta tuottaa skeemaan sopivan tiedontarpeen (resurssilajit sovelluksen taulusta)", () => {
    for (const intent of KNOWN_INTENTS) {
      const { need } = toInfoNeed(resp({ intent }), TODAY);
      expect(InfoNeedSchema.safeParse(need).success).toBe(true);
      expect(need.intent).toBe(intent);
      expect(need.resourceTypes).toEqual(INTENT_PROFILE[intent].types);
      expect(need.scope).toBe("patient");
      expect(need.timeRange).toBeNull();
      expect(need.clarificationQuestion).toBeNull();
    }
  });

  it("'none' ja epävarmuus johtavat tarkennukseen eikä hakuihin", () => {
    const none = toInfoNeed(resp({ intent: "none" }), TODAY).need;
    expect(none.intent).toBe("unknown");
    expect(none.clarificationQuestion).toMatch(/Tarkoitatko esimerkiksi/);
    const lowP = toInfoNeed(resp({ intent: "medications", p: THRESHOLDS.intentProbability - 0.01 }), TODAY).need;
    expect(lowP.intent).toBe("unknown");
    expect(lowP.clarificationQuestion).toMatch(/lääkitys/);
    const lowC = toInfoNeed(resp({ intent: "allergies", p: 0.9, conf: THRESHOLDS.intentConfidence - 0.01 }), TODAY).need;
    expect(lowC.intent).toBe("unknown");
    expect(lowC.rationale).toMatch(/epävarma/);
    expect(toInfoNeed(resp({ intent: "allergies", p: THRESHOLDS.intentProbability }), TODAY).need.intent).toBe("allergies");
  });

  it("kontaktirajaus vasta rajan ylittyessä", () => {
    expect(toInfoNeed(resp({ visit: THRESHOLDS.visitOnly }), TODAY).need.scope).toBe("encounter");
    expect(toInfoNeed(resp({ visit: THRESHOLDS.visitOnly - 0.01 }), TODAY).need.scope).toBe("patient");
  });

  it("aikaväli: päivämäärän laskee sovellus; epävarma aikaväli ei kavenna hakua", () => {
    expect(toInfoNeed(resp({ period: "month" }), TODAY).need.timeRange).toEqual({ since: daysAgo(TODAY, 30) });
    expect(toInfoNeed(resp({ period: "week" }), TODAY).need.timeRange).toEqual({ since: daysAgo(TODAY, 7) });
    expect(toInfoNeed(resp({ period: "year" }), TODAY).need.timeRange).toEqual({ since: daysAgo(TODAY, 365) });
    expect(toInfoNeed(resp({ period: "month", periodP: THRESHOLDS.period - 0.01 }), TODAY).need.timeRange).toBeNull();
    expect(toInfoNeed(resp({ period: "none" }), TODAY).need.timeRange).toBeNull();
  });

  it("odottamaton vastaus on virhe, ei arvaus", () => {
    const base = resp();
    const cases: JevResponse[] = [
      resp({ intent: "delete-everything" }),
      resp({ period: "decade" }),
      { ...base, answers: { visit_only: base.answers.visit_only, period: base.answers.period } },
      { ...base, answers: { ...base.answers, visit_only: { type: "choice", choice: "yes" } } },
    ];
    for (const c of cases) expect(() => toInfoNeed(c, TODAY)).toThrow(JevError);
  });

  it("tulos sisältää vain skeeman sallimat kentät (ei URL:ää, potilasta tai metodia)", () => {
    const { need } = toInfoNeed(resp({ visit: 0.9, period: "year" }), TODAY);
    expect(Object.keys(need).sort()).toEqual(["clarificationQuestion", "concepts", "intent", "rationale", "resourceTypes", "scope", "timeRange"]);
    expect(JSON.stringify(need)).not.toMatch(/http|Patient\/|POST|DELETE/);
  });
});

describe("Jev-adapteri ja kysy-putki", () => {
  const fakeClient = (r: JevResponse | Error) => ({ ask: vi.fn(async () => { if (r instanceof Error) throw r; return r; }) }) as unknown as JevClient & { ask: ReturnType<typeof vi.fn> };

  it("välittää diagnostiikan ja vain kysymystekstin", async () => {
    const c = fakeClient(resp());
    let diag: InterpretDiagnostics | undefined;
    await interpretWithJev(c, "  Näytä verenpaineet  ", { today: TODAY, onDiagnostics: (d) => (diag = d) });
    expect(c.ask.mock.calls[0][0]).toBe("Näytä verenpaineet");
    expect(diag?.thresholds).toEqual(THRESHOLDS);
    expect(diag?.intent.choice).toBe("blood-pressure");
  });

  it("Jev-virhe muuttuu palvelun ei-käytettävyydeksi ilman kysymystekstiä", async () => {
    const a = new JevLanguageAdapter(fakeClient(new JevError("rate-limit", 429)));
    const err = await a.interpretQuestion("Matti Meikäläisen verenpaine", { today: TODAY, hasEncounter: false }).catch((e) => e);
    expect(err).toBeInstanceOf(LanguageServiceUnavailable);
    expect(err.message).toMatch(/kutsuraja/);
    expect(err.message).not.toMatch(/Meikäläisen/);
  });

  it("vastaus ja rakenteistus ovat sovelluksen omia (Jev ei kirjoita tekstiä)", async () => {
    const a = new JevLanguageAdapter(fakeClient(resp()));
    const t = parsePastedTranscript("Lääkäri: RR 148/92");
    expect(await a.structureTranscript(t)).toEqual(mockStructure(t));
    expect(a.capabilities.answer).toBe("deterministic");
  });

  it("parafraasi → oikea potilas, oikeat haut, vastaus faktoista", async () => {
    const { ehr, idOf, fake } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    const lang = new JevLanguageAdapter(fakeClient(resp({ intent: "blood-pressure" })));
    const r = await runAsk({ question: "paljonko paine oli viimeksi", patientId: p1, today: TODAY, language: lang, ehr });
    expect(r.state).toBe("ok");
    expect(r.interpretedBy).toBe("model");
    expect(r.answerSource).toBe("deterministic");
    expect(r.interpretation).toMatchObject({ source: "jev" });
    expect(r.facts[0].text).toBe("138/88 mmHg");
    expect(r.answer).toMatch(/138\/88 mmHg/);
    expect(fake.calls.every((c) => c.method === "GET" && (c.url.includes(`patient=${p1}`) || c.url.endsWith("/metadata")))).toBe(true);
  });

  it("Jev alhaalla: virhe näkyy, hakuja ei tehdä eikä mock vaihdu huomaamatta", async () => {
    const { ehr, idOf, fake } = setup();
    const before = fake.calls.length;
    const lang = new JevLanguageAdapter(fakeClient(new JevError("timeout")));
    const r = await runAsk({ question: "Näytä verenpaineet", patientId: idOf("Patient", "demo-patient-1"), today: TODAY, language: lang, ehr });
    expect(r.state).toBe("service-unavailable");
    expect(r.answer).toMatch(/ei vastannut ajoissa/);
    expect(r.facts).toEqual([]);
    expect(fake.calls.length).toBe(before);
  });

  it("epävarma tulkinta → tarkennus ilman FHIR-hakuja", async () => {
    const { ehr, idOf, fake } = setup();
    const before = fake.calls.length;
    const lang = new JevLanguageAdapter(fakeClient(resp({ intent: "overview", p: 0.4 })));
    const r = await runAsk({ question: "Entä se toinen juttu?", patientId: idOf("Patient", "demo-patient-1"), today: TODAY, language: lang, ehr });
    expect(r.state).toBe("clarify");
    expect(fake.calls.length).toBe(before);
  });

  it("oikea JevClient: pyynnön runko sisältää vain kysymystekstin, ei potilastunnisteita", async () => {
    const { ehr, idOf } = setup();
    const p1 = idOf("Patient", "demo-patient-1");
    let sent = "";
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify(resp()), { status: 200 });
    }) as unknown as typeof fetch;
    const lang = new JevLanguageAdapter(new JevClient({ apiKey: "k", endpoint: "https://api.example.test/v1/systemone", model: "jev-latest", fetchImpl }));
    await runAsk({ question: "Näytä verenpaineet", patientId: p1, today: TODAY, language: lang, ehr });
    const body = JSON.parse(sent);
    expect(body.state).toBe("Näytä verenpaineet");
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(sent).not.toMatch(/Patient\/|Aino|Demolainen|patientId/);
    expect(JSON.stringify(body.questions)).not.toContain(`"${p1}"`);
  });
});
