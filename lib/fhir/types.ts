// Kevyet FHIR R4 -tyypit niille kentille, joita sovellus käyttää.

export interface Coding {
  system?: string;
  code?: string;
  display?: string;
}
export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}
export interface Reference {
  reference?: string;
  display?: string;
}
export interface Identifier {
  system?: string;
  value?: string;
}
export interface Quantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}
export interface Period {
  start?: string;
  end?: string;
}
export interface Annotation {
  text: string;
}
export interface Attachment {
  contentType?: string;
  data?: string;
  url?: string;
  title?: string;
  language?: string;
}
export interface Meta {
  versionId?: string;
  lastUpdated?: string;
  tag?: Coding[];
  profile?: string[];
}

export interface Resource {
  resourceType: string;
  id?: string;
  meta?: Meta;
  identifier?: Identifier[];
  [key: string]: unknown;
}

export interface OperationOutcomeIssue {
  severity: "fatal" | "error" | "warning" | "information";
  code: string;
  diagnostics?: string;
  details?: CodeableConcept;
}
export interface OperationOutcome extends Resource {
  resourceType: "OperationOutcome";
  issue: OperationOutcomeIssue[];
}

export interface BundleLink {
  relation: string;
  url: string;
}
export interface BundleEntry {
  fullUrl?: string;
  resource?: Resource;
  search?: { mode?: "match" | "include" | "outcome" };
  request?: { method: string; url: string; ifNoneExist?: string };
  response?: { status: string; location?: string; outcome?: Resource };
}
export interface Bundle extends Resource {
  resourceType: "Bundle";
  type: string;
  total?: number;
  link?: BundleLink[];
  entry?: BundleEntry[];
}

export interface HumanName {
  family?: string;
  given?: string[];
  text?: string;
}

export interface Patient extends Resource {
  resourceType: "Patient";
  name?: HumanName[];
  birthDate?: string;
  gender?: string;
}

export interface Encounter extends Resource {
  resourceType: "Encounter";
  status?: string;
  class?: Coding;
  type?: CodeableConcept[];
  subject?: Reference;
  period?: Period;
  reasonCode?: CodeableConcept[];
}

export interface ObservationComponent {
  code: CodeableConcept;
  valueQuantity?: Quantity;
}
export interface Observation extends Resource {
  resourceType: "Observation";
  status?: string;
  category?: CodeableConcept[];
  code?: CodeableConcept;
  subject?: Reference;
  encounter?: Reference;
  effectiveDateTime?: string;
  effectivePeriod?: Period;
  issued?: string;
  valueQuantity?: Quantity;
  valueString?: string;
  interpretation?: CodeableConcept[];
  referenceRange?: { low?: Quantity; high?: Quantity; text?: string }[];
  component?: ObservationComponent[];
  note?: Annotation[];
}

export const LOINC = "http://loinc.org";
export const SNOMED = "http://snomed.info/sct";
export const UCUM = "http://unitsofmeasure.org";
