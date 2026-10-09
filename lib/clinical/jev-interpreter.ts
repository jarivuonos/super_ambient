// Kysymyksen tulkinta Jevillä: yksi pyyntö, kolme tyypitettyä kysymystä.
// Jev palauttaa vain valinnan ja todennäköisyyksiä. Resurssilajit, hakurajaukset ja
// päivämäärät muodostaa sovellus; potilasta, URL:ää tai metodia ei voi antaa.

import {
  CLARIFY_GENERIC,
  INTENT_PROFILE,
  KNOWN_INTENTS,
  PERIODS,
  clarifyNear,
  periodToSince,
  type KnownIntent,
  type Period,
} from "./intents";
import { JevError, type JevClient, type JevQuestion, type JevResponse } from "./jev-client";
import type { InfoNeed } from "./schemas";

/** Rajat, joilla Jevin vastaus hyväksytään. Säädetään arviointijoukon (eval) perusteella. */
export const THRESHOLDS = {
  /**
   * Valitun tiedontarpeen todennäköisyys vähintään tämä, muuten pyydetään tarkennusta.
   * 0,8 valittu eval-ajon (79 kysymystä) perusteella: väärät tulkinnat osuivat välille 0,62–0,72, kun
   * oikeat vastaukset olivat lähes kaikki >= 0,8. Tarkista omalla irrotetulla joukolla ennen luottamista.
   */
  intentProbability: 0.8,
  intentConfidence: 0.5,
  /** Kontaktirajaus vain, jos väite "rajattu tähän käyntiin" on vähintään näin todennäköinen. */
  visitOnly: 0.7,
  /** Epävarma aikaväli tulkitaan "ei rajausta": rajaus ei saa kaventaa hakua huomaamatta. */
  period: 0.6,
} as const;

// Kriteerit englanniksi (suomenkieliset avainsanat mukana); kysymys itse on suomea.
export const INTENT_CRITERIA: Record<KnownIntent | "none", string> = {
  "blood-pressure": "Asks about the patient's blood pressure measurements (verenpaine, RR, systolic/diastolic readings).",
  "vital-signs": "Asks about other vital sign measurements such as pulse, heart rate, temperature, oxygen saturation, weight or height (syke, pulssi, lämpö, happisaturaatio, paino, pituus).",
  laboratory: "Asks about laboratory or blood test results (laboratoriotulokset, verikokeet, CRP, hemoglobin, creatinine, potassium, cholesterol, glucose).",
  medications: "Asks which medications the patient uses or has been prescribed (lääkitys, lääkkeet, reseptit).",
  allergies: "Asks about allergies or drug intolerances (allergiat, yliherkkyydet).",
  conditions: "Asks which specific diagnoses, diseases or listed problems the patient has (diagnoosit, sairaudet, ongelmalista, onko potilaalla sairautta X). A general question about what the patient's problem is belongs to overview, not here.",
  "imaging-report": "Asks about imaging studies or radiology reports such as X-ray, CT, MRI or ultrasound (kuvantaminen, röntgen, lausunto).",
  documents: "Asks about clinical notes, visit records or documents written about the patient (kirjaukset, käyntimerkinnät, epikriisi).",
  overview: "Asks for a broad summary of the patient's situation, key problems or recent changes, not limited to one data type (yhteenveto, tilanne, keskeiset ongelmat, viimeaikaiset muutokset). Also the general question 'what is the patient's problem?' (mikä potilaan ongelma on?).",
  none: "The text is not a request to look up patient record information, is too vague to tell what is wanted, or asks for something else: advice, treatment decisions, prognosis or predictions, general medical knowledge, small talk, or any request to delete, edit, create or order something. Also questions about record types this application does not cover, such as vaccinations, billing or appointments.",
};

const PERIOD_CRITERIA: Record<Period, string> = {
  none: "No time limit is mentioned. Words like 'latest' or 'most recent' (viimeisin, viimeisimmät, viimeksi) alone are not a time limit.",
  week: "Only the last week or last few days (viimeisen viikon aikana).",
  month: "Only the last month or 30 days (viime kuukausi, viimeisen kuukauden aikana).",
  year: "Only the last year or 12 months (viime vuosi, vuoden aikana).",
};

export function buildQuestions(): Record<string, JevQuestion> {
  return {
    intent: {
      type: "choice",
      instructions: "Which kind of patient record information does the clinician's question ask for? Choose the best match.",
      criteria: INTENT_CRITERIA,
    },
    visit_only: {
      type: "noul",
      instructions:
        "The question explicitly restricts itself to the current visit or encounter (for example 'tällä käynnillä', 'tässä kontaktissa', 'tämän käynnin'). A question about the patient's history in general is false.",
    },
    period: {
      type: "choice",
      instructions: "Does the question limit the results to a recent time period?",
      criteria: PERIOD_CRITERIA,
    },
  };
}

export interface InterpretDiagnostics {
  source: "jev";
  model: string | null;
  intent: { choice: string; probability: number; confidence: number };
  visitOnly: number;
  period: { choice: string; probability: number };
  thresholds: typeof THRESHOLDS;
  usage: { input_tokens?: number; output_tokens?: number } | null;
}

const PERIOD_FI: Record<Period, string> = { none: "ei rajausta", week: "viimeinen viikko", month: "viimeinen kuukausi", year: "viimeinen vuosi" };

function qualitative(p: number): string {
  return p >= 0.85 ? "korkea" : p >= 0.6 ? "kohtalainen" : "matala";
}

/** Muuntaa Jevin vastauksen tiedontarpeeksi. Odottamaton vastaus on virhe, ei arvaus. */
export function toInfoNeed(response: JevResponse, today: string): { need: InfoNeed; diagnostics: InterpretDiagnostics } {
  const bad = () => new JevError("bad-response");
  const intentAns = response.answers.intent;
  const visitAns = response.answers.visit_only;
  const periodAns = response.answers.period;
  if (intentAns?.type !== "choice" || visitAns?.type !== "noul" || periodAns?.type !== "choice") throw bad();

  const choice = intentAns.choice;
  const isKnown = (KNOWN_INTENTS as string[]).includes(choice);
  if (choice !== "none" && !isKnown) throw bad();
  if (!(PERIODS as readonly string[]).includes(periodAns.choice)) throw bad();

  const prob = intentAns.probabilities?.[choice] ?? intentAns.confidence ?? 0;
  const conf = intentAns.confidence ?? prob;
  const periodProb = periodAns.probabilities?.[periodAns.choice] ?? periodAns.confidence ?? 0;

  const diagnostics: InterpretDiagnostics = {
    source: "jev",
    model: response.model ?? null,
    intent: { choice, probability: prob, confidence: conf },
    visitOnly: visitAns.noul,
    period: { choice: periodAns.choice, probability: periodProb },
    thresholds: THRESHOLDS,
    usage: response.usage ?? null,
  };

  const unknown = (clarificationQuestion: string, rationale: string): InfoNeed => ({
    intent: "unknown",
    resourceTypes: [],
    concepts: [],
    timeRange: null,
    scope: "patient",
    clarificationQuestion,
    rationale,
  });

  if (choice === "none") {
    return { need: unknown(CLARIFY_GENERIC, "Jev-tulkinta: kysymys ei pyydä tunnistettua potilastietoa."), diagnostics };
  }
  const intent = choice as KnownIntent;
  if (prob < THRESHOLDS.intentProbability || conf < THRESHOLDS.intentConfidence) {
    return { need: unknown(clarifyNear(intent), `Jev-tulkinta: epävarma (lähin: ${INTENT_PROFILE[intent].fi}, varmuus ${qualitative(prob)}).`), diagnostics };
  }

  const scope: InfoNeed["scope"] = visitAns.noul >= THRESHOLDS.visitOnly ? "encounter" : "patient";
  const period = periodAns.choice as Period;
  const since = period !== "none" && periodProb >= THRESHOLDS.period ? periodToSince(period, today) : null;
  const profile = INTENT_PROFILE[intent];
  return {
    need: {
      intent,
      resourceTypes: profile.types,
      concepts: profile.concepts,
      timeRange: since ? { since } : null,
      scope,
      clarificationQuestion: null,
      rationale: `Jev-tulkinta: ${profile.fi} (varmuus ${qualitative(prob)}); rajaus: ${scope === "encounter" ? "valittu kontakti" : "koko potilas"}; aikaväli: ${since ? PERIOD_FI[period] : "ei rajausta"}.`,
    },
    diagnostics,
  };
}

export async function interpretWithJev(
  client: Pick<JevClient, "ask">,
  question: string,
  ctx: { today: string; signal?: AbortSignal; onDiagnostics?: (d: InterpretDiagnostics) => void },
): Promise<InfoNeed> {
  const response = await client.ask(question.trim(), buildQuestions(), ctx.signal);
  const { need, diagnostics } = toInfoNeed(response, ctx.today);
  ctx.onDiagnostics?.(diagnostics);
  return need;
}
