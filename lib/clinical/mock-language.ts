// Sääntöpohjainen MOCK-kysymystulkinta ja faktoihin perustuva vastaus. Ei kielimalli.

import { formatDate, isImagingReport, type Fact } from "./facts";
import { CLARIFY_GENERIC, INTENT_PROFILE, daysAgo, type KnownIntent } from "./intents";
import type { InfoNeed } from "./schemas";

const RULES: { re: RegExp; intent: KnownIntent }[] = [
  { re: /verenpain|\brr\b|\bvp\b/iu, intent: "blood-pressure" },
  { re: /(ongelm|muutok|yhteenvet|tilanne|kokonaiskuva|mikä potilaa)/iu, intent: "overview" },
  { re: /lääk/iu, intent: "medications" },
  { re: /allerg|yliherk/iu, intent: "allergies" },
  { re: /kuvanta|röntgen|\brtg\b|lausun|\bct\b|\btt\b|\bmri\b|magneet|ultraä/iu, intent: "imaging-report" },
  { re: /labor|\bhb\b|hemoglob|krea|kalium|\bcrp\b|kolester|\bldl\b|verikoe|näyte/iu, intent: "laboratory" },
  { re: /diagnoo|sairau/iu, intent: "conditions" },
  { re: /vitaal|syke|pulssi|lämpö|mittau/iu, intent: "vital-signs" },
  { re: /asiakirj|merkin|kertomus|teksti/iu, intent: "documents" },
];

export function mockInterpretQuestion(question: string, today: string): InfoNeed {
  const q = question.trim();
  const rule = RULES.find((r) => r.re.test(q));
  let since: string | null = null;
  if (/viime vuo|vuoden aja|12 kuuk/iu.test(q)) since = daysAgo(today, 365);
  else if (/(viime|viimeisen) kuukau|30 päiv/iu.test(q)) since = daysAgo(today, 30);
  else if (/(viime|viimeisen) viiko/iu.test(q)) since = daysAgo(today, 7);
  const encounterOnly = /(tällä käynnillä|tässä kontaktissa|tämän käynnin|tämän kontaktin)/iu.test(q);
  if (!rule) {
    return {
      intent: "unknown",
      resourceTypes: [],
      concepts: [],
      timeRange: null,
      scope: "patient",
      clarificationQuestion: CLARIFY_GENERIC,
      rationale: "Mock-tulkinta: kysymyksestä ei löytynyt tunnettua avainsanaa.",
    };
  }
  return {
    intent: rule.intent,
    resourceTypes: INTENT_PROFILE[rule.intent].types,
    concepts: INTENT_PROFILE[rule.intent].concepts,
    timeRange: since ? { since } : null,
    scope: encounterOnly ? "encounter" : "patient",
    clarificationQuestion: null,
    rationale: `Mock-tulkinta avainsanan perusteella (${rule.intent}).`,
  };
}

const ref = (f: Fact) => `[${f.source.resourceType}/${f.source.id}]`;
const line = (f: Fact) => `${f.label}: ${f.text} (${f.dateLabel} ${formatDate(f.date)}) ${ref(f)}`;

export function mockAnswer(need: InfoNeed, facts: Fact[], missing: string[], now = new Date()): string {
  const parts: string[] = [];
  const none = (what: string) =>
    `Tästä hausta ei löytynyt ${what}. Tämä ei tarkoita, ettei potilaalla olisi niitä – tieto voi puuttua tästä palvelimesta tai rajauksesta.`;
  switch (need.intent) {
    case "blood-pressure": {
      const bp = facts.filter((f) => f.kind.startsWith("bp-"));
      if (!bp.length) return none("verenpainemittauksia");
      const bpText = (f: Fact) => (f.kind === "bp-systolic" ? `systolinen ${f.text}` : f.kind === "bp-diastolic" ? `diastolinen ${f.text}` : f.text);
      const latest = bp[0];
      parts.push(`Viimeisin verenpainetieto: ${bpText(latest)} (${latest.dateLabel} ${formatDate(latest.date)}) ${ref(latest)}.`);
      // Erillisiä systolinen/diastolinen-resursseja ei yhdistetä pariksi. Samalta ajalta olevat näytetään
      // rinnakkain, mutta selvästi erillisinä.
      const sameTime =
        latest.kind === "bp-panel" || !latest.date
          ? []
          : bp.slice(1).filter((f) => f.kind !== "bp-panel" && f.kind !== latest.kind && f.date === latest.date);
      if (latest.kind !== "bp-panel") {
        parts.push(
          sameTime.length
            ? `Samalta ajalta on lisäksi ${sameTime.map((f) => `${bpText(f)} ${ref(f)}`).join("; ")}. Ne ovat erillisiä mittausresursseja, joita ei ole yhdistetty pariksi.`
            : "Viimeisin tieto on erillinen mittausresurssi, jota ei yhdistetä pariksi.",
        );
      }
      const earlier = bp.slice(1).filter((f) => !sameTime.includes(f)).slice(0, 4);
      if (earlier.length) {
        parts.push(`Aiemmat: ${earlier.map((f) => `${bpText(f)}${f.kind === "bp-panel" ? "" : " (erillinen)"} ${formatDate(f.date)} ${ref(f)}`).join("; ")}.`);
      }
      break;
    }
    case "medications": {
      if (!facts.length) return none("lääkitystietoja");
      parts.push(...facts.map(line));
      parts.push("Huom: lääkityslistan ajantasaisuutta ei voi päätellä pelkästään vanhoista lääkemääräyksistä; tarkista lääkitys potilaan kanssa.");
      break;
    }
    case "allergies":
      if (!facts.length) return none("allergiatietoja");
      parts.push(...facts.map(line));
      break;
    case "laboratory":
    case "vital-signs":
      if (!facts.length) return none(need.intent === "laboratory" ? "laboratoriotuloksia" : "vitaalimittauksia");
      parts.push(...facts.slice(0, 8).map(line));
      break;
    case "conditions":
      if (!facts.length) return none("ongelma- tai diagnoositietoja");
      parts.push(...facts.map(line));
      break;
    case "imaging-report": {
      const img = facts.filter(isImagingReport);
      const pick = img[0] ?? facts.find((f) => f.kind === "diagnostic-report");
      if (!pick) return none("kuvantamislausuntoja");
      parts.push(`Viimeisin lausunto: ${pick.text} (${pick.dateLabel} ${formatDate(pick.date)}) ${ref(pick)}.`);
      if (!img.length) parts.push("Lausuntoa ei voitu luokitella kuvantamiseksi; tarkista lähteestä.");
      if (pick.attachedText) parts.push("Lausunnon koko teksti näkyy lähteissä sellaisenaan.");
      break;
    }
    case "documents":
      if (!facts.length) return none("asiakirjoja");
      parts.push(...facts.slice(0, 6).map(line));
      break;
    case "overview": {
      const conds = facts.filter((f) => f.kind === "condition");
      const abnormal = facts.filter((f) => f.flags.some((x) => /viitealue|Tulkinta/.test(x)));
      const cutoff = now.getTime() - 90 * 24 * 3600 * 1000;
      const recent = facts.filter((f) => f.date && Date.parse(f.date) >= cutoff);
      parts.push(conds.length ? `Tunnetut ongelmat: ${conds.map((f) => `${f.text} (${f.flags.join(", ")}) ${ref(f)}`).join("; ")}.` : "Ongelmalistalta ei löytynyt kirjauksia tästä hausta.");
      parts.push(abnormal.length ? `Poikkeavat havainnot: ${abnormal.map((f) => `${f.label} ${f.text} – ${f.flags[0]} (${formatDate(f.date)}) ${ref(f)}`).join("; ")}.` : "Poikkeavia havaintoja ei löytynyt haetuista resursseista.");
      parts.push(recent.length ? `Viimeiset 90 vrk: ${recent.slice(0, 6).map((f) => `${f.label} ${f.text} (${formatDate(f.date)}) ${ref(f)}`).join("; ")}.` : "Viimeisen 90 vuorokauden ajalta ei löytynyt kirjauksia.");
      parts.push("Yhteenveto ei ole uusi diagnoosi; se kokoaa vain haetut kirjaukset.");
      break;
    }
    default:
      return need.clarificationQuestion ?? "Tiedontarve jäi epäselväksi.";
  }
  if (need.timeRange?.since) parts.push(`Rajaus: tiedot ${formatDate(need.timeRange.since)} alkaen.`);
  if (need.scope === "encounter") parts.push("Rajaus: vain valittu kontakti.");
  if (missing.length) parts.push("Katso myös puuttuvat tai keskeneräiset haut.");
  return parts.join("\n");
}
