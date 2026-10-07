import { z } from "zod";
import { READABLE_RESOURCE_TYPES } from "../fhir/search-builders";

// ---------- Tiedontarve (kielimallin tulkinta kysymyksestä) ----------

export const INTENTS = [
  "blood-pressure",
  "vital-signs",
  "laboratory",
  "medications",
  "allergies",
  "conditions",
  "imaging-report",
  "documents",
  "overview",
  "unknown",
] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * Malli palauttaa vain tämän rakenteen. Se ei voi antaa URL:ää, potilasta,
 * palvelinta tai HTTP-metodia: ylimääräiset kentät hylätään (strictObject).
 */
export const InfoNeedSchema = z.strictObject({
  intent: z.enum(INTENTS),
  resourceTypes: z.array(z.enum(READABLE_RESOURCE_TYPES as [string, ...string[]])).max(7),
  concepts: z.array(z.string().max(80)).max(10),
  timeRange: z
    .strictObject({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() })
    .nullable(),
  scope: z.enum(["patient", "encounter"]),
  clarificationQuestion: z.string().max(300).nullable(),
  rationale: z.string().max(500),
});
export type InfoNeed = z.infer<typeof InfoNeedSchema>;

// ---------- Litteraatti ----------

export const SPEAKERS = ["ammattilainen", "potilas", "läheinen", "tuntematon"] as const;
export type Speaker = (typeof SPEAKERS)[number];

export const TranscriptSegmentSchema = z.strictObject({
  id: z.string().regex(/^s\d{1,4}$/),
  speaker: z.enum(SPEAKERS),
  text: z.string().max(5000),
  startMs: z.number().int().nonnegative().nullable(),
  endMs: z.number().int().nonnegative().nullable(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.strictObject({
  version: z.string().min(8).max(64),
  origin: z.enum(["liitetty", "litteroitu", "esimerkki"]),
  /** Mistä puhujaroolit ovat peräisin: käyttäjän merkinnät, litterointipalvelu vai ei tiedossa. */
  speakerSource: z.enum(["käyttäjän merkinnät", "litterointipalvelu", "ei tiedossa"]),
  segments: z.array(TranscriptSegmentSchema).min(1).max(500),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

// ---------- Rakenteistamisehdotukset ----------

export const PROPOSAL_TYPES = [
  "reason",
  "symptom",
  "bp",
  "heart-rate",
  "temperature",
  "medication-mention",
  "allergy-mention",
  "procedure-history",
  "assessment",
  "condition",
  "family-history",
  "plan",
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export const CERTAINTIES = ["suora", "tulkinnanvarainen", "ristiriitainen"] as const;
export const REVIEW_STATUSES = ["tarkistamatta", "hyväksytty", "hylätty"] as const;
export const CONDITION_VERIFICATION = ["provisional", "differential", "unconfirmed", "confirmed"] as const;

export const CodingSchema = z.strictObject({
  system: z.string().max(200),
  code: z.string().max(64),
  display: z.string().max(200),
});

export const ProposalValueSchema = z.strictObject({
  text: z.string().min(1).max(1000),
  bp: z.strictObject({ systolic: z.number().int(), diastolic: z.number().int() }).nullable().optional(),
  quantity: z.strictObject({ value: z.number(), unit: z.string().max(20) }).nullable().optional(),
  verificationStatus: z.enum(CONDITION_VERIFICATION).nullable().optional(),
});

export const SourceRefSchema = z.strictObject({
  transcriptVersion: z.string(),
  segmentId: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string().max(1000),
  speaker: z.enum(SPEAKERS),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Mallin tuottama ehdotus (ilman sovelluksen hallitsemia tarkistuskenttiä). */
export const ModelProposalSchema = z.strictObject({
  proposalId: z.string().regex(/^p\d{1,4}$/),
  type: z.enum(PROPOSAL_TYPES),
  value: ProposalValueSchema,
  source: SourceRefSchema,
  certainty: z.enum(CERTAINTIES),
  issues: z.array(z.string().max(300)).max(10),
  subject: z.enum(["potilas", "läheinen", "muu"]),
  negation: z.boolean(),
  temporality: z.string().max(120).nullable(),
  codingCandidate: CodingSchema.nullable(),
  targetResourceType: z.enum(["Observation", "Condition"]).nullable(),
});
export type ModelProposal = z.infer<typeof ModelProposalSchema>;

export const ProposalSchema = ModelProposalSchema.extend({
  reviewStatus: z.enum(REVIEW_STATUSES),
  /** Hyväksyntähetken sisältötiiviste; muokkaus mitätöi hyväksynnän. */
  approvedHash: z.string().nullable(),
  /** Sovelluksen tekemät tarkistushuomiot (esim. koodi poistettu). */
  appIssues: z.array(z.string()).max(10),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const NoteDraftSchema = z.strictObject({
  reason: z.string().max(4000),
  history: z.string().max(8000),
  findings: z.string().max(8000),
  assessment: z.string().max(4000),
  plan: z.string().max(4000),
});
export type NoteDraft = z.infer<typeof NoteDraftSchema>;

/** Yhden mallikutsun skeema: käyntimerkintäluonnos + ehdotukset. */
export const StructuringOutputSchema = z.strictObject({
  note: NoteDraftSchema,
  proposals: z.array(ModelProposalSchema).max(100),
});
export type StructuringOutput = z.infer<typeof StructuringOutputSchema>;

export const NOTE_SECTION_LABELS: Record<keyof NoteDraft, string> = {
  reason: "Käynnin syy",
  history: "Esitiedot (potilaan/läheisen kertoma)",
  findings: "Nykytila ja havainnot (mitattu/todettu)",
  assessment: "Arvio (ammattilaisen keskustelussa ilmaisema)",
  plan: "Suunnitelma",
};

export const PROPOSAL_TYPE_LABELS: Record<ProposalType, string> = {
  reason: "Käynnin syy",
  symptom: "Oire",
  bp: "Verenpaine",
  "heart-rate": "Syke",
  temperature: "Lämpö",
  "medication-mention": "Lääkitysmaininta",
  "allergy-mention": "Allergiamaininta",
  "procedure-history": "Aiempi toimenpide",
  assessment: "Arvio",
  condition: "Ongelma / diagnoosiepäily",
  "family-history": "Sukuanamneesi",
  plan: "Suunnitelma",
};
