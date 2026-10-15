// Alustava arkkitehtuurimalli (ArchiMate 3.1). Tämä tiedosto on mallin ainoa lähde:
// scripts/architecture/generate.ts tuottaa siitä Open Group Exchange -XML:n, SVG-näkymät ja PDF:n.
// Sisältö on johdettu koodista; jokaisella komponentilla on `source`-polut, jotka generaattori tarkistaa.
// Tila (`status`) erottaa toteutetun, valinnaisen, ei-konfiguroidun, pysäytetyn ja suunnitellun.

export type Status =
  | "implemented" // toteutettu ja käytössä
  | "opt-in" // toteutettu, mutta oletuksena pois (asetuksella)
  | "not-configured" // rajapinta on, palvelua ei ole kytketty
  | "parked" // tarkoituksella sivuun jätetty
  | "planned" // suunniteltu, ei toteutettu
  | "current" // nykyinen ympäristö tai tosiasia
  | "external" // ulkopuolinen palvelu (ei tämän projektin koodia)
  | "dev-tooling"; // kehitysaikainen työkalu

export type ElementType =
  | "Stakeholder" | "Driver" | "Goal" | "Principle" | "Requirement" | "Constraint"
  | "BusinessActor" | "BusinessRole" | "BusinessProcess" | "BusinessService" | "BusinessObject"
  | "ApplicationComponent" | "ApplicationInterface" | "ApplicationService" | "DataObject"
  | "Node" | "SystemSoftware" | "Artifact" | "TechnologyService" | "CommunicationNetwork"
  | "WorkPackage" | "Plateau";

export type RelType =
  | "Composition" | "Assignment" | "Realization" | "Serving" | "Access" | "Influence"
  | "Triggering" | "Flow" | "Association";

export type Layer = "Motivation" | "Business" | "Application" | "Technology" | "Implementation and migration";

export const LAYER_OF: Record<ElementType, Layer> = {
  Stakeholder: "Motivation", Driver: "Motivation", Goal: "Motivation", Principle: "Motivation",
  Requirement: "Motivation", Constraint: "Motivation",
  BusinessActor: "Business", BusinessRole: "Business", BusinessProcess: "Business",
  BusinessService: "Business", BusinessObject: "Business",
  ApplicationComponent: "Application", ApplicationInterface: "Application",
  ApplicationService: "Application", DataObject: "Application",
  Node: "Technology", SystemSoftware: "Technology", Artifact: "Technology",
  TechnologyService: "Technology", CommunicationNetwork: "Technology",
  WorkPackage: "Implementation and migration", Plateau: "Implementation and migration",
};

export interface El {
  id: string;
  type: ElementType;
  name: string;
  status: Status;
  doc: string;
  /** Repon polut, joista elementti on johdettu (tarkistetaan generoitaessa). */
  source?: string[];
}

export interface Rel {
  type: RelType;
  source: string;
  target: string;
  access?: "Read" | "Write" | "ReadWrite";
  /** Suhde on suunnitelmassa tai pysäytetty eikä toteutettu. */
  status?: Status;
}

const e = (id: string, type: ElementType, name: string, status: Status, doc: string, source?: string[]): El => ({ id, type, name, status, doc, source });

export const ELEMENTS: El[] = [
  // ---------------- Motivation ----------------
  e("stk-clin", "Stakeholder", "Clinician", "current", "Reads patient data and documents consultations; the intended end user."),
  e("stk-owner", "Stakeholder", "Application owner and developer", "current", "Decides scope, approves plans and runs the live evaluations."),
  e("stk-doctor", "Stakeholder", "Medical doctor (domain reviewer)", "current", "Not yet involved in review. Will advise on blood pressure pairing and clinical labels."),
  e("stk-it", "Stakeholder", "Employer IT (future Azure tenant)", "current", "Will host the application in a later phase."),
  e("drv-load", "Driver", "Documentation workload and scattered patient data", "current", "Clinicians spend time finding data and writing notes."),
  e("goal-understand", "Goal", "Understand the patient's situation quickly", "current", "Ask questions in plain language and get source-grounded answers."),
  e("goal-document", "Goal", "Document the consultation smoothly", "current", "Turn a conversation into a reviewable note and structured suggestions."),
  e("goal-demo", "Goal", "Show where smart classification helps, safely", "current", "Use Jev as a classifier inside strict, human-reviewed boundaries."),
  e("pr-human", "Principle", "Human approval before anything is saved", "implemented", "Proposals start unreviewed; edits revoke approval; the save path re-checks everything."),
  e("pr-grounded", "Principle", "Answers and proposals trace to a source", "implemented", "Facts carry resource id and field; proposals carry an exact transcript quote."),
  e("pr-app-fhir", "Principle", "The application, not a model, builds FHIR", "implemented", "Typed builders produce every saved resource; model output is never sent as a bundle."),
  e("pr-secrets", "Principle", "Secrets and keys stay on the server", "implemented", "Keys are read from server-side environment variables only; errors never carry them."),
  e("con-synth", "Constraint", "Synthetic data only (public, unauthenticated test server)", "current", "The public HAPI server has no privacy and is wiped periodically."),
  e("con-optin", "Constraint", "Sending transcript text to a third party is opt-in", "implemented", "LLM_STRUCTURING=jev is off by default and warns in the UI."),
  e("req-scope", "Requirement", "Patient and encounter context enforced on every read and write", "implemented", "Returned and followed resources are checked against the selected patient; writes only for demo-tagged patients.", ["lib/fhir/patient-guard.ts", "lib/workflow/save.ts"]),
  e("req-fallback", "Requirement", "Works without a model service (visible mock mode)", "implemented", "Default provider is a rule-based mock that is labelled as such.", ["lib/clinical/language-adapter.ts"]),

  // ---------------- Business ----------------
  e("ba-clin", "BusinessActor", "Clinician", "current", "The person using the workspace."),
  e("br-clin", "BusinessRole", "Treating clinician", "current", "Role that asks, records, reviews and saves."),
  e("bp-ask", "BusinessProcess", "Ask about patient data", "implemented", "Pose a question, read the answer with its source observations."),
  e("bp-record", "BusinessProcess", "Record and document a consultation", "implemented", "Record or paste a rehearsal conversation and build a note draft."),
  e("bp-review", "BusinessProcess", "Review and approve proposals", "implemented", "Edit, approve or reject each structured suggestion and the note."),
  e("bp-save", "BusinessProcess", "Save approved content to the EHR", "implemented", "Preview, save as one transaction, and read the resources back."),
  e("bs-info", "BusinessService", "Patient information retrieval", "implemented", "Answers to questions about the selected patient."),
  e("bs-doc", "BusinessService", "Consultation documentation", "implemented", "Draft note and structured proposals from a conversation."),
  e("bo-note", "BusinessObject", "Visit note", "implemented", "The consultation note (käyntimerkintä); saved as a DocumentReference with docStatus preliminary."),
  e("bo-record", "BusinessObject", "Patient record", "implemented", "The patient's data held in the EHR (the public HAPI server in the demo)."),

  // ---------------- Application ----------------
  e("ac-web", "ApplicationComponent", "Web UI", "implemented", "React client: patient and visit selection, Ask view, recording and documentation view.", ["components/Workspace.tsx", "components/AskView.tsx", "components/RecordView.tsx", "components/ui.tsx", "components/api.ts"]),
  e("ac-workspace", "ApplicationComponent", "Workspace shell", "implemented", "Persistent context bar, patient search, encounter picker, status and seeding panels; guards against stale responses.", ["components/Workspace.tsx"]),
  e("ac-askview", "ApplicationComponent", "Ask view", "implemented", "Question box, answer, source facts, search plan and technical details.", ["components/AskView.tsx"]),
  e("ac-recordview", "ApplicationComponent", "Recording and documentation view", "implemented", "Audio capture, transcript editor, sample conversations, proposal table, preview, save and read-back.", ["components/RecordView.tsx"]),
  e("ac-server", "ApplicationComponent", "Application server", "implemented", "Server-side logic in Next.js route handlers and the lib/ modules; holds all secrets and external connections.", ["app/api", "lib"]),
  e("ac-api", "ApplicationComponent", "API layer (route handlers)", "implemented", "Validates request bodies with strict schemas and delegates to the services.", ["app/api/ask/route.ts", "app/api/structure/route.ts", "app/api/save/route.ts", "app/api/save/preview/route.ts", "app/api/read/route.ts", "app/api/patients/route.ts", "app/api/encounters/route.ts", "app/api/status/route.ts"]),
  e("ac-qa", "ApplicationComponent", "Question answering", "implemented", "Interprets a question, runs allow-listed read searches, extracts facts and composes a grounded answer.", ["lib/clinical/ask.ts", "lib/clinical/facts.ts", "lib/clinical/intents.ts"]),
  e("ac-interp", "ApplicationComponent", "Question interpreter", "implemented", "Maps a question to an information need: Jev classification or keyword mock.", ["lib/clinical/jev-interpreter.ts", "lib/clinical/mock-language.ts"]),
  e("ac-struct", "ApplicationComponent", "Transcript structuring", "opt-in", "Turns a transcript into a note draft and proposals. Mock rules by default; Jev classifies sentences when LLM_STRUCTURING=jev.", ["lib/clinical/jev-structurer.ts", "lib/clinical/sentence-classifier.ts", "lib/clinical/mock-structurer.ts", "lib/clinical/sentences.ts", "lib/clinical/measurements.ts", "lib/clinical/text-rules.ts"]),
  e("ac-review", "ApplicationComponent", "Review and approval engine", "implemented", "Approval hashes, staleness, allowed FHIR targets and validation of structuring output.", ["lib/workflow/review.ts"]),
  e("ac-save", "ApplicationComponent", "Save service", "implemented", "Server-side re-check, preview, validation, one transaction with conditional create, read-back and timeout recovery.", ["lib/workflow/save.ts"]),
  e("ac-build", "ApplicationComponent", "FHIR builders and patient guard", "implemented", "Allow-listed search builders, typed resource builders and the patient-scope guard.", ["lib/fhir/search-builders.ts", "lib/fhir/resource-builders.ts", "lib/fhir/patient-guard.ts"]),
  e("ac-ehr", "ApplicationComponent", "EHR adapter (HAPI R4, Epic)", "implemented", "EhrAdapter interface and its R4 implementation: paging, limits, retries, capability check, optional Bearer token. One shared instance for sources without login; a new instance per request for sources with login.", ["lib/fhir/ehr-adapter.ts", "lib/fhir/hapi-adapter.ts", "lib/fhir/http.ts", "lib/services.ts"]),
  e("ac-sources", "ApplicationComponent", "FHIR source registry", "implemented", "The only place that defines a source: address, login type, write permission and patient-search form. The browser sends only a source id; unknown ids are rejected and read-only sources refuse writes.", ["lib/fhir/sources.ts"]),
  e("ac-auth", "ApplicationComponent", "SMART login and session", "implemented", "Authorization code flow with PKCE (S256) as a public client; endpoints discovered from the server and restricted to its origin. The access token lives in an httpOnly cookie that only the server reads; no server-side session store.", ["lib/auth/pkce.ts", "lib/auth/smart.ts", "lib/auth/session.ts", "lib/auth/errors.ts", "app/api/auth/[source]/login/route.ts", "app/api/auth/[source]/callback/route.ts", "app/api/auth/[source]/logout/route.ts"]),
  e("ac-lang", "ApplicationComponent", "Language adapter", "implemented", "Selects mock, Jev hybrid or unavailable and reports per capability who does what.", ["lib/clinical/language-adapter.ts"]),
  e("ac-jev", "ApplicationComponent", "Jev client", "opt-in", "Timeout, bounded retries, strict response parsing; errors never carry key or text.", ["lib/clinical/jev-client.ts", "lib/jev-settings.ts"]),
  e("ac-seed", "ApplicationComponent", "Demo data seeding", "implemented", "User-triggered upload of the app's own synthetic fixtures (second write path next to the save service).", ["app/api/seed/route.ts", "lib/fhir/fixtures.ts"]),
  e("ac-stt", "ApplicationComponent", "Transcription adapter", "not-configured", "Interface for speech-to-text; no provider is wired, so transcripts are pasted by hand.", ["lib/transcription/adapter.ts", "app/api/transcribe/route.ts"]),
  e("ac-conf", "ApplicationComponent", "Configuration and service wiring", "implemented", "Reads environment settings and creates the adapters.", ["lib/config.ts", "lib/services.ts"]),
  e("ac-eval", "ApplicationComponent", "Evaluation and smoke tooling", "dev-tooling", "Eval scripts (mock and live Jev), HAPI smoke test and browser walkthrough.", ["scripts/eval-interpret.ts", "scripts/eval-structure.ts", "scripts/smoke-hapi.ts", "scripts/ui-e2e.ts"]),
  e("ac-tests", "ApplicationComponent", "Automated tests (Vitest)", "dev-tooling", "Unit and integration tests against an in-memory FHIR fake and a scripted Jev; no UI or route tests.", ["tests"]),
  e("ai-rest", "ApplicationInterface", "Internal REST/JSON API (/api/*)", "implemented", "The only interface between browser and server.", ["app/api"]),
  e("as-ask", "ApplicationService", "Patient data question service", "implemented", "POST /api/ask."),
  e("as-struct", "ApplicationService", "Transcript structuring service", "implemented", "POST /api/structure."),
  e("as-save", "ApplicationService", "Documentation save service", "implemented", "POST /api/save/preview, /api/save and /api/read."),
  e("as-ehr", "ApplicationService", "EHR access service", "implemented", "Patient, encounter and resource reads and the write transaction."),
  e("do-need", "DataObject", "Information need", "implemented", "Strict schema: intent, resource types, time range, scope. Never contains a URL or patient."),
  e("do-fact", "DataObject", "Fact (source-grounded)", "implemented", "A value or statement with resource id, fields and clinical time."),
  e("do-transcript", "DataObject", "Transcript", "implemented", "Speaker-labelled segments with a content version."),
  e("do-proposal", "DataObject", "Proposal", "implemented", "Reviewable suggestion: type, value, exact source quote, certainty, review status."),
  e("do-note", "DataObject", "Note draft", "implemented", "Reason, history, findings, assessment and plan sections."),
  e("do-bundle", "DataObject", "Transaction bundle and snapshot", "implemented", "The previewed bundle and the hash the server re-checks."),
  e("do-fhir", "DataObject", "FHIR resources", "implemented", "Patient, Encounter, Observation, Condition, DocumentReference and read-only types."),
  e("do-fixtures", "DataObject", "Demo fixtures", "implemented", "Two synthetic patients with visits, vitals, labs, medication, allergy, problem and a report.", ["lib/fhir/fixtures.ts"]),
  e("do-gold", "DataObject", "Sample conversations and gold sets", "dev-tooling", "14 synthetic conversations and question sets; written by an AI, not reviewed by a doctor.", ["lib/clinical/sample-conversations.ts", "scripts/data/question-eval-set.ts"]),

  // ---------------- Technology ----------------
  e("tn-browser", "Node", "Clinician's browser", "current", "Runs the React client; captures audio locally and keeps it in memory."),
  e("ss-media", "SystemSoftware", "Browser audio capture (MediaRecorder)", "implemented", "Audio is never sent to HAPI; it goes to a transcription service only on an explicit action."),
  e("art-client", "Artifact", "Client JavaScript bundle", "implemented", "Output of next build."),
  e("art-cookie", "Artifact", "Access-token cookie (httpOnly)", "implemented", "Holds the OAuth access token for a source that needs login (about one hour). SameSite=Strict, Secure on https; unreadable by page scripts.", ["lib/auth/session.ts"]),
  e("tn-dev", "Node", "Developer workstation (Linux)", "current", "bun run dev; no Node installed, Bun runs everything."),
  e("ss-bun", "SystemSoftware", "Bun runtime and package manager", "current", "bun@1.4.2, bun.lock.", ["package.json"]),
  e("ss-next", "SystemSoftware", "Next.js 16 and React 19", "current", "App Router with cacheComponents.", ["next.config.ts", "package.json"]),
  e("tn-vercel", "Node", "Vercel hosting (current)", "current", "Hosts the deployed demo; not protected by login unless Deployment Protection is on."),
  e("ss-nextrun", "SystemSoftware", "Next.js server runtime", "current", "Serverless functions; capability cache is per instance."),
  e("art-server", "Artifact", "Next.js server build", "implemented", "Route handlers and server modules."),
  e("art-config", "Artifact", "Server environment configuration", "implemented", "Host environment variables or a local env file; holds the Jev key and the Epic client id.", ["lib/config.ts", ".env.example"]),
  e("tn-azure", "Node", "Employer Azure tenant (planned)", "planned", "Target hosting; may also run an ICD-API VM."),
  e("tn-hapi", "Node", "HAPI FHIR public test server", "external", "https://hapi.fhir.org/baseR4; shared, unauthenticated, wiped periodically."),
  e("ts-fhir", "TechnologyService", "FHIR R4 REST API", "external", "Search, read, $validate and transaction."),
  e("tn-epic", "Node", "Epic on FHIR sandbox", "external", "https://fhir.epic.com/interconnect-fhir-oauth; synthetic test patients, login with documented test users; the app reads only."),
  e("ts-epic-fhir", "TechnologyService", "Epic FHIR R4 API", "external", "Patient (demographics search needs a birth date with the name), Encounter, Observation and other reads."),
  e("ts-epic-oauth", "TechnologyService", "Epic SMART / OAuth 2.0 service", "external", "authorize and token endpoints from .well-known/smart-configuration; PKCE S256, standalone launch, public client."),
  e("tn-typesafe", "Node", "Typesafe AI cloud (Jev)", "external", "https://api.typesafe.ai/v1/systemone; data-processing terms not yet checked."),
  e("ts-jev", "TechnologyService", "System One classification API", "external", "Typed questions (choice, score, noul) over a state; no text generation."),
  e("tn-icd", "Node", "ICD-API service (local, systemd)", "parked", "Runs on the owner's machine (port 8382); unreachable from Vercel."),
  e("ts-icd", "TechnologyService", "ICD-11 search API", "parked", "Possible future code suggestions; ICD-10 would be needed for production."),
  e("net-internet", "CommunicationNetwork", "Internet (HTTPS)", "current", "All browser-to-server and server-to-service traffic."),

  // ---------------- Implementation and migration ----------------
  e("wp-core", "WorkPackage", "Core workspace, HAPI adapter and save path", "implemented", "Delivered first version of the specification."),
  e("wp-jev-q", "WorkPackage", "Jev question interpretation", "implemented", "Classifier-based interpretation with thresholds and an evaluation set."),
  e("wp-jev-s", "WorkPackage", "Jev transcript structuring with clause splitting", "opt-in", "Opt-in hybrid structuring; evaluation on synthetic gold set."),
  e("wp-guard", "WorkPackage", "Agent guardrails (AGENTS.md, permissions, hook)", "implemented", "Project instructions, permission rules and an .env hook.", ["AGENTS.md", ".claude/settings.json", ".claude/hooks/block-env-reads.sh"]),
  e("wp-epic", "WorkPackage", "Second FHIR source: Epic sandbox (read-only, SMART login)", "implemented", "Source registry and selector, PKCE login with cookie session, Epic search shapes and test-patient list. Verified by the owner for login, patient search, encounters and questions on blood pressure, labs, allergies, medications, conditions, imaging reports, documents and the overview (medication names are read from the reference display; an imaging document is recognised from its type; Epic needs a category on Observation searches, so the overview splits observations into vitals and labs).", ["lib/fhir/sources.ts", "lib/auth"]),
  e("wp-epic-q", "WorkPackage", "Verify all question types against Epic", "implemented", "Every question type has been tried by hand. Findings: Epic ignores _sort, requires a category or code on Observation searches and offers no MedicationStatement in R4 (403); the app reports the 403 on purpose and explains 401 and 403 clearly."),
  e("wp-epic-cloud", "WorkPackage", "Epic login from the Vercel deployment", "implemented", "Callback URI registered at Epic, client id set in Vercel, code deployed. The owner confirmed that login works from the deployed app. Epic took about ten minutes to accept the new URI, and it compares the URI literally (https, exact path)."),
  e("wp-heldout", "WorkPackage", "Held-out evaluation with doctor-written transcripts", "planned", "The real accuracy check; the current sets are in-sample."),
  e("wp-qa", "WorkPackage", "Question-and-answer pair handling", "planned", "Short replies such as 'Ei.' need the preceding question."),
  e("wp-progress", "WorkPackage", "Progress indication for structuring", "planned", "About 300 ms per sentence at concurrency 1."),
  e("wp-azure", "WorkPackage", "Migrate to the employer's Azure tenant", "planned", "Hosting, secrets store, identity and network rules."),
  e("wp-icd", "WorkPackage", "ICD-11 code suggestions", "parked", "Nice-to-have; needs a Finnish-to-English vocabulary step."),
  e("pl-demo", "Plateau", "Plateau 1: Vercel demo with Jev", "current", "Today's state."),
  e("pl-azure", "Plateau", "Plateau 2: Azure-hosted demo", "planned", "Target state, still a demo."),
];

const r = (type: RelType, source: string, target: string, extra: Partial<Rel> = {}): Rel => ({ type, source, target, ...extra });

export const RELATIONS: Rel[] = [
  // Motivation
  r("Association", "stk-clin", "drv-load"), r("Association", "stk-owner", "drv-load"),
  r("Association", "stk-doctor", "goal-document"), r("Association", "stk-it", "wp-azure"),
  r("Influence", "drv-load", "goal-understand"), r("Influence", "drv-load", "goal-document"),
  r("Influence", "pr-grounded", "goal-understand"), r("Influence", "pr-human", "goal-document"),
  r("Influence", "pr-app-fhir", "goal-document"), r("Influence", "pr-secrets", "goal-demo"),
  r("Realization", "req-scope", "goal-understand"), r("Realization", "req-fallback", "goal-demo"),
  r("Association", "con-synth", "req-scope"), r("Association", "con-optin", "pr-secrets"),

  // Business
  r("Assignment", "ba-clin", "br-clin"),
  r("Assignment", "br-clin", "bp-ask"), r("Assignment", "br-clin", "bp-record"),
  r("Assignment", "br-clin", "bp-review"), r("Assignment", "br-clin", "bp-save"),
  r("Triggering", "bp-record", "bp-review"), r("Triggering", "bp-review", "bp-save"),
  r("Realization", "bp-ask", "bs-info"), r("Realization", "bp-record", "bs-doc"),
  r("Serving", "bs-info", "br-clin"), r("Serving", "bs-doc", "br-clin"),
  r("Access", "bp-ask", "bo-record", { access: "Read" }), r("Access", "bp-record", "bo-note", { access: "Write" }),
  r("Access", "bp-review", "bo-note", { access: "ReadWrite" }), r("Access", "bp-save", "bo-record", { access: "Write" }),
  r("Realization", "do-note", "bo-note"), r("Realization", "do-fhir", "bo-record"),
  r("Serving", "as-ask", "bp-ask"), r("Serving", "as-struct", "bp-record"), r("Serving", "as-save", "bp-save"),
  r("Serving", "ac-recordview", "bp-review"), r("Serving", "ac-askview", "bp-ask"),

  // Application structure
  r("Composition", "ac-web", "ac-workspace"), r("Composition", "ac-web", "ac-askview"), r("Composition", "ac-web", "ac-recordview"),
  ...["ac-api", "ac-qa", "ac-interp", "ac-struct", "ac-review", "ac-save", "ac-build", "ac-ehr", "ac-sources", "ac-auth", "ac-lang", "ac-jev", "ac-seed", "ac-stt", "ac-conf"].map((t) => r("Composition", "ac-server", t)),
  r("Flow", "ac-api", "ac-sources"), r("Flow", "ac-api", "ac-auth"), r("Flow", "ac-auth", "ac-ehr"), r("Flow", "ac-sources", "ac-ehr"),
  r("Association", "ac-conf", "ac-sources"), r("Association", "ac-conf", "ac-auth"), r("Association", "ac-auth", "art-cookie"),
  r("Composition", "ac-api", "ai-rest"), r("Serving", "ai-rest", "ac-web"),

  // Application cooperation (information flow)
  r("Flow", "ac-web", "ac-api"),
  r("Flow", "ac-api", "ac-qa"), r("Flow", "ac-api", "ac-struct"), r("Flow", "ac-api", "ac-save"),
  r("Flow", "ac-api", "ac-seed"), r("Flow", "ac-api", "ac-stt"), r("Flow", "ac-api", "ac-ehr"),
  r("Flow", "ac-qa", "ac-lang"), r("Flow", "ac-lang", "ac-interp"), r("Flow", "ac-lang", "ac-struct"),
  r("Flow", "ac-interp", "ac-jev"), r("Flow", "ac-struct", "ac-jev"),
  r("Flow", "ac-qa", "ac-ehr"), r("Flow", "ac-qa", "ac-build"),
  r("Flow", "ac-struct", "ac-review"), r("Flow", "ac-save", "ac-review"),
  r("Flow", "ac-save", "ac-ehr"), r("Flow", "ac-save", "ac-build"), r("Flow", "ac-seed", "ac-ehr"), r("Flow", "ac-ehr", "ac-build"),
  r("Association", "ac-conf", "ac-lang"), r("Association", "ac-conf", "ac-ehr"), r("Association", "ac-conf", "ac-jev"),

  // Services and data
  r("Realization", "ac-qa", "as-ask"), r("Realization", "ac-struct", "as-struct"),
  r("Realization", "ac-save", "as-save"), r("Realization", "ac-ehr", "as-ehr"),
  r("Serving", "as-ehr", "ac-qa"), r("Serving", "as-ehr", "ac-save"), r("Serving", "as-ehr", "ac-seed"),
  r("Access", "ac-qa", "do-need", { access: "Write" }), r("Access", "ac-qa", "do-fact", { access: "Write" }), r("Access", "ac-qa", "do-fhir", { access: "Read" }),
  r("Access", "ac-struct", "do-transcript", { access: "Read" }), r("Access", "ac-struct", "do-proposal", { access: "Write" }), r("Access", "ac-struct", "do-note", { access: "Write" }),
  r("Access", "ac-review", "do-proposal", { access: "ReadWrite" }),
  r("Access", "ac-save", "do-proposal", { access: "Read" }), r("Access", "ac-save", "do-bundle", { access: "Write" }), r("Access", "ac-save", "do-fhir", { access: "ReadWrite" }),
  r("Access", "ac-seed", "do-fixtures", { access: "Read" }), r("Access", "ac-seed", "do-fhir", { access: "Write" }),
  r("Access", "ac-eval", "do-gold", { access: "Read" }),
  r("Association", "ac-recordview", "do-gold"),

  // Technology
  r("Composition", "tn-browser", "ss-media"), r("Composition", "tn-dev", "ss-bun"), r("Composition", "tn-dev", "ss-next"), r("Composition", "tn-vercel", "ss-nextrun"),
  r("Assignment", "tn-browser", "art-client"), r("Assignment", "tn-vercel", "art-server"), r("Assignment", "tn-azure", "art-server", { status: "planned" }),
  r("Realization", "art-client", "ac-web"), r("Realization", "art-server", "ac-server"),
  r("Association", "art-config", "ac-conf"), r("Association", "art-config", "art-server"),
  r("Realization", "tn-hapi", "ts-fhir"), r("Realization", "tn-typesafe", "ts-jev"), r("Realization", "tn-icd", "ts-icd"),
  r("Serving", "ts-fhir", "ac-ehr"), r("Serving", "ts-jev", "ac-jev"),
  r("Realization", "tn-epic", "ts-epic-fhir"), r("Realization", "tn-epic", "ts-epic-oauth"),
  r("Serving", "ts-epic-fhir", "ac-ehr"), r("Serving", "ts-epic-oauth", "ac-auth"),
  r("Assignment", "tn-browser", "art-cookie"), r("Flow", "tn-vercel", "tn-epic"), r("Association", "net-internet", "tn-epic"),
  r("Flow", "tn-browser", "tn-vercel"), r("Flow", "tn-vercel", "tn-hapi"), r("Flow", "tn-vercel", "tn-typesafe"),
  r("Association", "net-internet", "tn-browser"), r("Association", "net-internet", "tn-vercel"), r("Association", "net-internet", "tn-azure"),
  r("Association", "net-internet", "tn-hapi"), r("Association", "net-internet", "tn-typesafe"),
  r("Association", "tn-icd", "wp-icd"),

  // Implementation and migration
  r("Triggering", "wp-core", "wp-jev-q"), r("Triggering", "wp-jev-q", "wp-jev-s"),
  r("Association", "wp-core", "pl-demo"), r("Association", "wp-jev-q", "pl-demo"), r("Association", "wp-jev-s", "pl-demo"), r("Association", "wp-guard", "pl-demo"),
  r("Association", "wp-heldout", "pl-azure"), r("Association", "wp-qa", "pl-azure"), r("Association", "wp-progress", "pl-azure"),
  r("Association", "wp-azure", "pl-azure"), r("Association", "wp-icd", "pl-azure"),
  r("Triggering", "pl-demo", "pl-azure"),
  r("Association", "wp-epic", "pl-demo"), r("Association", "wp-epic-q", "pl-demo"), r("Association", "wp-epic-cloud", "pl-demo"),
  r("Association", "wp-epic", "ac-auth"), r("Association", "wp-epic", "ac-sources"), r("Triggering", "wp-epic", "wp-epic-q"), r("Triggering", "wp-epic", "wp-epic-cloud"),
  r("Association", "wp-azure", "tn-azure"), r("Association", "wp-jev-q", "ac-interp"), r("Association", "wp-jev-s", "ac-struct"),
];

// ------------------------------------------------------------------------------------------------
// Näkymät. Ruudukon yksikkö: sarake ≈ 182 px, rivi ≈ 92 px. Sisäkkäiset ryhmät: `kids`.
// ------------------------------------------------------------------------------------------------

export interface NodeSpec {
  id: string;
  col: number;
  row: number;
  /** Sisäkkäiset lapset (ruudukko ryhmän sisällä). */
  kids?: { ids: string[]; cols: number };
}

export interface ViewSpec {
  id: string;
  name: string;
  description: string;
  nodes: NodeSpec[];
  /** Piirrettävät suhteet muodossa "tyyppi:lähde>kohde" (komponointi sisäkkäisyydestä tulee itsestään). */
  edges: string[];
}

export const VIEWS: ViewSpec[] = [
  {
    id: "v-motivation",
    name: "1 Motivation",
    description: "Why the application exists: stakeholders, the driver, goals, and the principles, requirements and constraints that shape the design.",
    nodes: [
      { id: "stk-clin", col: 1, row: 0 }, { id: "stk-owner", col: 2, row: 0 }, { id: "stk-it", col: 3, row: 0 }, { id: "stk-doctor", col: 4, row: 0 },
      { id: "drv-load", col: 2, row: 1 },
      { id: "req-scope", col: 0, row: 2 }, { id: "goal-understand", col: 1, row: 2 }, { id: "goal-document", col: 2, row: 2 }, { id: "goal-demo", col: 3, row: 2 }, { id: "req-fallback", col: 4, row: 2 },
      { id: "con-synth", col: 0, row: 3 }, { id: "pr-grounded", col: 1, row: 3 }, { id: "pr-human", col: 2, row: 3 }, { id: "pr-app-fhir", col: 3, row: 3 }, { id: "pr-secrets", col: 4, row: 3 },
      { id: "con-optin", col: 4, row: 4 },
    ],
    edges: [
      "Association:stk-clin>drv-load", "Association:stk-owner>drv-load", "Association:stk-doctor>goal-document",
      "Influence:drv-load>goal-understand", "Influence:drv-load>goal-document",
      "Influence:pr-grounded>goal-understand", "Influence:pr-human>goal-document", "Influence:pr-app-fhir>goal-document", "Influence:pr-secrets>goal-demo",
      "Realization:req-scope>goal-understand", "Realization:req-fallback>goal-demo",
      "Association:con-synth>req-scope", "Association:con-optin>pr-secrets",
    ],
  },
  {
    id: "v-business",
    name: "2 Business usage",
    description: "How a clinician uses the application: the role, the four processes, the business services they realize, and the application services and views that support them.",
    nodes: [
      { id: "ba-clin", col: 1.5, row: 0 }, { id: "br-clin", col: 1.5, row: 1 },
      { id: "bs-info", col: 0, row: 1 }, { id: "bs-doc", col: 3, row: 1 },
      { id: "bp-ask", col: 0, row: 2.2 }, { id: "bp-record", col: 1, row: 2.2 }, { id: "bp-review", col: 2, row: 2.2 }, { id: "bp-save", col: 3, row: 2.2 },
      { id: "as-ask", col: 0, row: 3.4 }, { id: "as-struct", col: 1, row: 3.4 }, { id: "ac-recordview", col: 2, row: 3.4 }, { id: "as-save", col: 3, row: 3.4 },
    ],
    edges: [
      "Assignment:ba-clin>br-clin", "Assignment:br-clin>bp-ask", "Assignment:br-clin>bp-record", "Assignment:br-clin>bp-review", "Assignment:br-clin>bp-save",
      "Triggering:bp-record>bp-review", "Triggering:bp-review>bp-save",
      "Realization:bp-ask>bs-info", "Realization:bp-record>bs-doc", "Serving:bs-info>br-clin", "Serving:bs-doc>br-clin",
      "Serving:as-ask>bp-ask", "Serving:as-struct>bp-record", "Serving:ac-recordview>bp-review", "Serving:as-save>bp-save",
    ],
  },
  {
    id: "v-app-structure",
    name: "3 Application structure",
    description: "Decomposition of the application: the web UI, the server-side modules with the source files they are built from, and the development tooling. Composition is shown by nesting.",
    nodes: [
      { id: "ac-web", col: 0, row: 0, kids: { ids: ["ac-workspace", "ac-askview", "ac-recordview"], cols: 1 } },
      { id: "ac-server", col: 1.35, row: 0, kids: { ids: ["ac-api", "ac-qa", "ac-interp", "ac-struct", "ac-review", "ac-save", "ac-build", "ac-ehr", "ac-sources", "ac-auth", "ac-lang", "ac-jev", "ac-seed", "ac-stt", "ac-conf"], cols: 4 } },
      { id: "ac-eval", col: 1.35, row: 4.2 }, { id: "ac-tests", col: 2.35, row: 4.2 },
    ],
    edges: [],
  },
  {
    id: "v-app-coop",
    name: "4 Application cooperation",
    description: "Main information flows between the application components, and the external technology services they depend on (Jev, HAPI and Epic). Flows involving the configuration module are left out for readability; see the appendix.",
    nodes: [
      { id: "ac-web", col: 0, row: 2.5 }, { id: "ac-api", col: 1, row: 2.5 },
      { id: "ac-qa", col: 2, row: 0.5 }, { id: "ac-struct", col: 2, row: 2 }, { id: "ac-save", col: 2, row: 3.5 }, { id: "ac-seed", col: 2, row: 4.8 }, { id: "ac-stt", col: 1, row: 6 },
      { id: "ac-lang", col: 3, row: 0.5 }, { id: "ac-interp", col: 4, row: 0.5 }, { id: "ac-jev", col: 4, row: 1.8 }, { id: "ts-jev", col: 5, row: 1.8 },
      { id: "ac-review", col: 3, row: 2.8 }, { id: "ac-ehr", col: 3, row: 4.5 }, { id: "ac-build", col: 4, row: 3.4 }, { id: "ts-fhir", col: 4, row: 4.7 },
      { id: "ai-rest", col: 0.2, row: 4 }, { id: "as-ehr", col: 3, row: 5.9 },
      { id: "ac-sources", col: 1, row: 0.5 }, { id: "ac-auth", col: 0, row: 1 },
      { id: "ts-epic-fhir", col: 4, row: 5.9 }, { id: "ts-epic-oauth", col: 0, row: 0 },
    ],
    edges: [
      "Flow:ac-web>ac-api", "Flow:ac-api>ac-qa", "Flow:ac-api>ac-struct", "Flow:ac-api>ac-save", "Flow:ac-api>ac-seed", "Flow:ac-api>ac-stt",
      "Flow:ac-qa>ac-lang", "Flow:ac-lang>ac-interp", "Flow:ac-lang>ac-struct", "Flow:ac-interp>ac-jev", "Flow:ac-struct>ac-jev",
      "Flow:ac-struct>ac-review", "Flow:ac-save>ac-review", "Flow:ac-save>ac-ehr", "Flow:ac-seed>ac-ehr", "Flow:ac-ehr>ac-build",
      "Serving:ts-jev>ac-jev", "Serving:ts-fhir>ac-ehr",
      "Serving:ai-rest>ac-web", "Composition:ac-api>ai-rest", "Realization:ac-ehr>as-ehr",
      "Flow:ac-api>ac-sources", "Flow:ac-api>ac-auth", "Serving:ts-epic-fhir>ac-ehr", "Serving:ts-epic-oauth>ac-auth",
    ],
  },
  {
    id: "v-information",
    name: "5 Information",
    description: "Which components read and write which information objects, and how the data objects realize the business objects. Question answering also reads the FHIR resources (read access not drawn here; see the appendix). The FHIR resources are the only data persisted outside the application.",
    nodes: [
      { id: "ac-qa", col: 0, row: 0.5 }, { id: "ac-struct", col: 0, row: 2.6 }, { id: "ac-review", col: 0, row: 3.8 }, { id: "ac-save", col: 0, row: 5.4 }, { id: "ac-seed", col: 0, row: 7 }, { id: "ac-eval", col: 0, row: 8 },
      { id: "do-need", col: 2, row: 0 }, { id: "do-fact", col: 2, row: 1 }, { id: "do-transcript", col: 2, row: 2 }, { id: "do-proposal", col: 2, row: 3 }, { id: "do-note", col: 2, row: 4 },
      { id: "do-bundle", col: 2, row: 5 }, { id: "do-fhir", col: 2, row: 6 }, { id: "do-fixtures", col: 2, row: 7 }, { id: "do-gold", col: 2, row: 8 },
      { id: "bo-note", col: 3, row: 4 }, { id: "bo-record", col: 3, row: 6 },
    ],
    edges: [
      "Access:ac-qa>do-need", "Access:ac-qa>do-fact",
      "Access:ac-struct>do-transcript", "Access:ac-struct>do-proposal", "Access:ac-struct>do-note",
      "Access:ac-review>do-proposal",
      "Access:ac-save>do-proposal", "Access:ac-save>do-bundle", "Access:ac-save>do-fhir",
      "Access:ac-seed>do-fixtures", "Access:ac-seed>do-fhir", "Access:ac-eval>do-gold",
      "Realization:do-note>bo-note", "Realization:do-fhir>bo-record",
    ],
  },
  {
    id: "v-technology",
    name: "6 Technology and deployment",
    description: "Where the application runs and what it talks to. Planned and parked elements are drawn dashed. Node-to-node flows (browser to Vercel to HAPI and Typesafe) are in the model but not drawn here.",
    nodes: [
      { id: "tn-browser", col: 0, row: 0, kids: { ids: ["ss-media", "art-client", "art-cookie"], cols: 1 } },
      { id: "tn-epic", col: 0.7, row: 7, kids: { ids: ["ts-epic-fhir", "ts-epic-oauth"], cols: 1 } },
      { id: "tn-vercel", col: 1.4, row: 0, kids: { ids: ["ss-nextrun", "art-server", "art-config"], cols: 1 } },
      { id: "tn-azure", col: 3.2, row: 0 },
      { id: "net-internet", col: 0.7, row: 3.3 },
      { id: "tn-hapi", col: 0, row: 4.6, kids: { ids: ["ts-fhir"], cols: 1 } },
      { id: "tn-typesafe", col: 1.4, row: 4.6, kids: { ids: ["ts-jev"], cols: 1 } },
      { id: "tn-icd", col: 2.8, row: 4.6, kids: { ids: ["ts-icd"], cols: 1 } },
      { id: "tn-dev", col: 4.2, row: 4.6, kids: { ids: ["ss-bun", "ss-next"], cols: 1 } },
    ],
    edges: [
      "Association:net-internet>tn-browser", "Association:net-internet>tn-vercel", "Association:net-internet>tn-azure",
      "Association:net-internet>tn-hapi", "Association:net-internet>tn-typesafe", "Association:net-internet>tn-epic", "Assignment:tn-azure>art-server",
    ],
  },
  {
    id: "v-roadmap",
    name: "7 Implementation and migration",
    description: "What has been delivered, and what is planned or parked on the way from the Vercel demo to an Azure-hosted demo. Nothing here is committed scope.",
    nodes: [
      { id: "wp-core", col: 0, row: 0 }, { id: "wp-jev-q", col: 1, row: 0 }, { id: "wp-jev-s", col: 2, row: 0 }, { id: "wp-guard", col: 3, row: 0 },
      { id: "pl-demo", col: 1.2, row: 1.7 }, { id: "pl-azure", col: 3, row: 1.7 },
      { id: "wp-epic", col: 0, row: 1.7 }, { id: "wp-epic-q", col: 4, row: 1.7 }, { id: "wp-epic-cloud", col: 4, row: 0 },
      { id: "wp-heldout", col: 0, row: 3.4 }, { id: "wp-qa", col: 1, row: 3.4 }, { id: "wp-progress", col: 2, row: 3.4 }, { id: "wp-azure", col: 3, row: 3.4 }, { id: "wp-icd", col: 4, row: 3.4 },
    ],
    edges: [
      "Triggering:wp-core>wp-jev-q", "Triggering:wp-jev-q>wp-jev-s",
      "Association:wp-epic>pl-demo",
      "Association:wp-core>pl-demo", "Association:wp-jev-q>pl-demo", "Association:wp-jev-s>pl-demo", "Association:wp-guard>pl-demo",
      "Triggering:pl-demo>pl-azure",
      "Association:wp-heldout>pl-azure", "Association:wp-qa>pl-azure", "Association:wp-progress>pl-azure", "Association:wp-azure>pl-azure", "Association:wp-icd>pl-azure",
    ],
  },
];
