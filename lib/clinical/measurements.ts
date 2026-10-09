// Mittausarvojen poiminta tekstistä (RR, syke, lämpö). Arvot tulevat aina koodista, ei mallilta.

import { VITAL_CODES } from "./codes";
import type { ModelProposal, SourceRef } from "./schemas";
import { L, NB } from "./text-rules";

const BP_CONTEXT_RE = /(rr|verenpain|vp|uusintamittau|mmhg)/iu;
const BP_RE = /(?<!\d)(\d{2,3})\s*\/\s*(\d{2,3})(?!\d)/gu;
const HR_RE = new RegExp(`${NB}(syke|pulssi|p)\\s*(?:on|oli|:)?\\s*(\\d{2,3})(?!\\d)`, "giu");
const TEMP_RE = new RegExp(`${NB}(lämpö|lämmöt|temp${L}*)\\s*(?:on|oli|:)?\\s*(\\d{2}(?:[,.]\\d{1,2})?)(?![\\d])`, "giu");

export interface MeasurementHit {
  type: "bp" | "heart-rate" | "temperature";
  value: ModelProposal["value"];
  /** Merkkikohdat lauseen sisällä. */
  relStart: number;
  relEnd: number;
  plausible: boolean;
  temporality: string;
  codingCandidate: NonNullable<ModelProposal["codingCandidate"]>;
  issues: string[];
}

const NO_TIME = "Mittausaikaa ei ilmaistu keskustelussa; aikaa ei lisätä.";
const fmt = (n: number) => String(n).replace(".", ",");

export function extractMeasurements(text: string): MeasurementHit[] {
  const hits: MeasurementHit[] = [];
  if (BP_CONTEXT_RE.test(text)) {
    const re = new RegExp(BP_RE.source, "gu");
    let prevEnd = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const sys = Number(m[1]);
      const dia = Number(m[2]);
      const between = text.slice(prevEnd, m.index).toLowerCase();
      prevEnd = m.index + m[0].length;
      const plausible = sys >= 50 && sys <= 260 && dia >= 30 && dia <= 160 && sys > dia;
      hits.push({
        type: "bp",
        value: { text: `Verenpaine ${sys}/${dia} mmHg`, bp: { systolic: sys, diastolic: dia }, quantity: null, verificationStatus: null },
        relStart: m.index,
        relEnd: m.index + m[0].length,
        plausible,
        temporality: /uusinta/.test(between) ? "uusintamittaus tällä käynnillä" : /ensin/.test(between) ? "ensimmäinen mittaus tällä käynnillä" : "tällä käynnillä",
        codingCandidate: VITAL_CODES.bpPanel,
        issues: [NO_TIME, ...(plausible ? [] : ["Arvo on epätavallinen; tarkista litteraatti."])],
      });
    }
  }
  const hr = new RegExp(HR_RE.source, "giu");
  for (let m = hr.exec(text); m; m = hr.exec(text)) {
    const v = Number(m[2]);
    const plausible = v >= 25 && v <= 250;
    hits.push({
      type: "heart-rate",
      value: { text: `Syke ${v} /min`, bp: null, quantity: { value: v, unit: "/min" }, verificationStatus: null },
      relStart: m.index,
      relEnd: m.index + m[0].length,
      plausible,
      temporality: "tällä käynnillä",
      codingCandidate: VITAL_CODES.heartRate,
      issues: [NO_TIME, ...(plausible ? [] : ["Arvo on epätavallinen."])],
    });
  }
  const tp = new RegExp(TEMP_RE.source, "giu");
  for (let m = tp.exec(text); m; m = tp.exec(text)) {
    const v = Number(m[2].replace(",", "."));
    const plausible = v >= 34 && v <= 43;
    hits.push({
      type: "temperature",
      value: { text: `Lämpö ${fmt(v)} °C`, bp: null, quantity: { value: v, unit: "Cel" }, verificationStatus: null },
      relStart: m.index,
      relEnd: m.index + m[0].length,
      plausible,
      temporality: "tällä käynnillä",
      codingCandidate: VITAL_CODES.temperature,
      issues: [NO_TIME, ...(plausible ? [] : ["Arvo on epätavallinen."])],
    });
  }
  return hits;
}

export function toMeasurementProposal(hit: MeasurementHit, ids: { proposalId: string; source: SourceRef; subject: ModelProposal["subject"] }): ModelProposal {
  return {
    proposalId: ids.proposalId,
    type: hit.type,
    value: hit.value,
    source: ids.source,
    certainty: hit.plausible ? "suora" : "ristiriitainen",
    issues: [...hit.issues],
    subject: ids.subject,
    negation: false,
    temporality: hit.temporality,
    codingCandidate: hit.codingCandidate,
    targetResourceType: "Observation",
  };
}
