<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# super_ambient: project instructions

## Project at a glance

- A demo, not a production system: a Finnish-language patient workspace on the public HAPI FHIR R4 test server. Synthetic data only. The UI also lets you read other patients on the public HAPI (read-only, demo-only filter on by default); saving is limited to the app's demo-tagged patients. The UI, README and code comments are Finnish; match that style.
- Stack: Bun (`bun@1.4.2`, `bun.lock`; there is no Node on the dev machine), Next.js 16.4 (App Router, `cacheComponents` on), React 19.3, TypeScript, Zod, Vitest.
- Layout: `app/api/` server routes · `components/` UI · `lib/clinical/` question interpretation, transcript structuring, Jev · `lib/fhir/` adapter, HTTP layer, builders, fixtures · `lib/workflow/` approval and save · `lib/transcription/` · `scripts/` smoke, e2e and eval scripts · `tests/`.
- `README.md` is the architecture description. Update it together with the change; do not create a parallel one.
- Keep the existing adapter boundaries and server-side secrets. Fix problems you observe; do not swap the stack for the sake of this file.

## Commands

| Check | Command | When |
| --- | --- | --- |
| Lint | `bun run lint` | every code change |
| Types | `bun run typecheck` | every code change |
| Tests | `bun run test` | every code change (in-memory FHIR fake, no network) |
| Build | `bun run build` | before handing off a code change; report an environment blocker separately |
| Interpretation eval, mock | `bun run eval:interpret` | interpretation logic or eval-data changes |
| Structuring eval, mock | `bun run eval:structure` | structuring logic or eval-data changes |

- Docs-only change: review the diff, check that commands match `package.json`, check the instructions do not contradict each other. Do not run the app tests for Markdown.
- The eval scripts exit 0 whatever the quality. Read the numbers; never report an eval as "passed" from the exit code. No baseline or acceptance limits are agreed yet: do not invent, tighten or loosen any.
- There is no CI (`.github/` is absent). Propose it as a separate change; do not claim merge gates exist.

## Ask first (these write somewhere or send data out)

- `SMOKE_HAPI=1 bun run smoke:hapi` and `SMOKE_HAPI=1 APP_URL=… bun run e2e:ui` **write to the public HAPI**. The e2e run also needs the app running and Firefox (`FIREFOX_PATH`).
- `bun run eval:interpret -- --jev` and `bun run eval:structure -- --jev` send text to Typesafe (Jev), cost money and use the owner's key. The owner runs these. Never run them yourself.
- Never include these in routine local checks. Use synthetic data only.
- If `next dev` adds a "Report Next.js feedback" block here, that is an external reporting action. Do it only if the owner confirms.

## Never

- Open, print or log `.env*` or any secret (`TYPESAFE_API_KEY` lives in `.env.local`, server-side only). When you start a server for checks, blank the keys so no real call can happen: `TYPESAFE_API_KEY= LLM_API_KEY= bun --bun next start …` (process env wins over `.env.local`).
- Commit, push, merge or publish unless asked.
- Change the defaults `LLM_PROVIDER=mock`, `LLM_STRUCTURING=mock`, `TRANSCRIPTION_PROVIDER=none`, or switch services on just to check something.
- Add a new outbound host, a runtime dependency, or a paid or new service without approval. Say so in the handoff when you add a dev dependency.
- Use real patient data anywhere: repo, fixtures, screenshots, logs or reports.
- Weaken, skip or delete tests, or change acceptance criteria or this file, to get a change through.

## Safety invariants (do not break them; most have tests, except the parts of 7 and 8 noted below)

1. **Patient scoping.** Every searched, returned or followed resource is checked against the selected patient. Reads go through allow-listed search builders; the model cannot set the patient, a URL or an HTTP method.
2. **Writes** go through two paths only. Clinical content uses the server-side save path (`lib/workflow/save.ts`): human-approved content only, one `transaction` with conditional create, only for demo-tagged patients, and the Encounter must belong to the patient. "Saved on the server" and "read back" are reported as separate states. The app's own demo fixtures use the explicit, user-triggered seed route (`app/api/seed/route.ts`). The `smoke:hapi` script also writes (see Ask first). Do not add another write path.
3. **Approvals go stale.** Editing a proposal or the transcript, or changing the patient or encounter, invalidates approvals. The saved snapshot must match the previewed one.
4. **FHIR comes only from the app's typed builders**, never from model output, and never with non-standard fields.
5. **Never invent times or values.** Values come from code (regex), not from a model. An unstated measurement time means no `effective[x]`. Separate systolic and diastolic Observations stay separate (a doctor will decide pairing).
6. **Clinical semantics.** A relative's facts never become a patient Condition. Negated findings and past measurements are never saved as this visit's resources. Suspected diagnoses stay `provisional`. Unknown codes are dropped.
7. **Text is data.** FHIR text and transcripts render as plain text, never HTML; embedded instructions change nothing; attachment URLs are never fetched automatically. (Plain-text rendering has no test, because the UI is not tested.)
8. **No secrets or question or transcript text in errors or logs.** Jev errors carry only a status and a fixed message. (Tested for Jev errors; the single `logError` in `lib/services.ts` is not.)
9. **Model output is validated.** Everything derived from a model (question interpretation, proposals) uses strict Zod schemas. The raw Jev API response is parsed tolerantly on purpose (`lib/clinical/jev-client.ts`, so extra fields from a third party do not break us) and then mapped to those strict structures. A broken response never reaches the save path.

## Jev and other AI features

- Jev is a classifier (`choice`, `score`, `noul`), not a text generator. Do not write code that expects free text from it. Settings and defaults are in `lib/jev-settings.ts`.
- Question interpretation sends only the question text. `LLM_STRUCTURING=jev` also sends transcript sentences (no identifiers) to Typesafe, so it is opt-in and synthetic-only until the data-processing terms are checked.
- The gold sets (`scripts/data/question-eval-set.ts`, `lib/clinical/sample-conversations.ts`) were written by an AI, not reviewed by a doctor. The thresholds (`THRESHOLDS`, `SENTENCE_THRESHOLDS`) were tuned on the same data. Do not tune on the data you evaluate with: ask for held-out cases, and when you change criteria or thresholds, report before and after numbers.
- Behaviour that varies run to run belongs in eval sets and live evals, not in the deterministic tests.

## Gotchas

- Modules with `import "server-only"` (`lib/config.ts`, `lib/services.ts`) cannot be imported by tests or scripts. Keep pure logic in modules without it, as `lib/jev-settings.ts` does.
- With `cacheComponents`, a route handler that needs request-time data calls `await connection()` (see `app/api/status/route.ts`). Check the bundled docs before adding segment config.
- Tests run in Node under Vitest: no component rendering, and the HTTP routes themselves are not covered. Do not say helper-function tests cover routes or the UI. Use `tests/fake-fhir.ts` and `tests/jev-scripted.ts` for doubles.
- The e2e script checks one desktop size (1400 × 1000). Mobile and accessibility are not verified.
- The public HAPI is shared and wiped periodically. Never hard-code ids; find demo data by identifier or tag.
- A hook in `.claude/hooks/block-env-reads.sh` denies any Bash command whose text names a `.env*` file (except `.env.example`), escaped forms included. In searches write `process[.]env`, not `process\.env`.

## Working agreement

- Small, reviewable changes, one logical unit at a time. Before coding, state goal, scope, acceptance criteria and checks (a few sentences is enough for small changes).
- Ask approval for a significant architecture change, a new external service, a broad dependency change or a hard-to-undo operation. Do not re-ask for routine steps once a plan is approved.
- Derive tests from the requirements, not from the current behaviour. Add tests for new behaviour and risks; do not add tests that only mirror a small cosmetic change.
- A UI change needs a rendered check (e2e run or screenshot) and a look at keyboard use, focus and labels. If you did not do that, report it as not checked.
- After implementing, review the real diff against the agreed criteria. Keep automated checks, your own review and the human's judgement separate. Never call your self-review an independent audit.
- WCAG 2.2 AA and OWASP ASVS are the targets once this leaves demo status. Apply the relevant items to changed code and say which version and scope you used.

## Handoff report

State: what changed and why (files); which agreed criteria are met and the evidence; checks run with command and result; problems found and fixed or left open; what the human still has to decide.

- Use PASSED / FAILED / NOT CHECKED / NOT APPLICABLE, and give a reason for the last two.
- Do not call an unrun test, an unseen view or an undone security check passed, and do not give a blanket verdict on the app's security.
- For a significant change, put the report in the PR description or ask where to store it. Do not create `docs/` folders unasked.
- "Implemented", "approved by a human" and "released" are separate states.

## Keeping this file useful

- Aim for under about 120 lines. Details belong in `README.md` or `docs/`. Personal or machine-specific rules do not belong here.
- Rules a machine can check belong in tests, CI or permission settings, not only in prose. These instructions are context, not enforcement.
- When a finding repeats, propose a precise addition here or an automated check. The human approves changes to this file.
