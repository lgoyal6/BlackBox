# Phase 09 — Decision Capture, Postmortem Generator, ePCR Draft

**Status:** PENDING
**Tasks:** US-017, US-018
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 40 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Write the three memory writers that close the loop: a `decisions` insert that refuses an empty rationale before it touches the database, a live postmortem generator marked `origin: "live"` that never reads `_groundTruth`, and an unsigned ePCR draft whose Clinical rationale section is filled from recorded decisions. These functions are what PHASE-11's `record_decision` and `close_call` routes call; this phase does not own those routes.

## Why These Writers Exist

Critical Rule 4 is the product: a decision without a rationale is a bug. Enforcing that in PHASE-02's JSON Schema validator is necessary and not sufficient — a rejected insert during the live demo is a worse failure than a thrown error in the writer that the route can turn into a 400. Throw first, in process, on empty or whitespace-only `rationale`, before any Mongo call.

The live postmortem is what the next crew retrieves. Seeded narratives (`origin: "seeded"`, `SEED_TARGET = 40`, templated by default) already exist from PHASE-06. Live ones must occupy the same register and length band so vector search treats them as the same kind of document. They must be labeled `origin: "live"` so `POST /api/demo/reset` can delete them without touching the seed corpus.

The ePCR draft is what sells the product to real medics. It is a draft, never a legal record, and it is the one place the captured rationales are shown as a clinical narrative rather than as dashboard tiles.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §5 — `DecisionDoc`, `PostmortemDoc`, `IncidentDoc`, `PUBLIC_INCIDENT_PROJECTION`. Implement those document shapes literally. Do not add fields.
- `.ralph/contracts.md` §4 — `DecisionOutcome`, `MemoryOrigin` (`"live"` is the only origin this phase writes), `callTypeFamily()`, `labelFor()`.
- `.ralph/contracts.md` §9 — this phase **implements `MemoryPort`**. Default-export it from `src/lib/memory/index.ts`. Consume `EmbeddingsPort`, `LlmPort`, and `EventsPort` through the registry.
- `.ralph/contracts.md` §10 — `record_decision` acknowledges in 300 ms and writes in the background; `close_call` has an 8-second budget. Keep the writer path inside that budget. Do not create the routes.
- `.ralph/contracts.md` §11 — `fixtures/utterances.json` (8 medic utterances with expected action/rationale splits) and `fixtures/incidents.json`.
- `.ralph/contracts.md` §13 — every vector write sets both `embedding` and `embeddedText`; never read `_groundTruth` outside seeding and the closing-metrics script.
- `.ralph/contracts.md` §14 — `SEED_TARGET = 40`, templated default. Match the seeded register so forty templated neighbours plus one live document still retrieve.
- `.ralph/overview.md` — Critical Rules 4, 5, 6; file ownership table. PHASE-06 owns `src/lib/memory/seed.ts` in this same folder — do not touch it.
- `.ralph/specs/phase-16-integration-cutover.md` — smoke asserts one live decision with a non-empty rationale and one `origin: "live"` postmortem. This phase supplies the functions that make those assertions true; it does not write `scripts/smoke.ts`.
- `src/lib/fakes/embeddings.ts`, `src/lib/fakes/llm.ts`, `src/lib/fakes/events.ts` — verify against these.

Implement `MemoryPort` as specified in `contracts.md` §9. Default-export the port object from `src/lib/memory/index.ts`. PHASE-08 and PHASE-11 call `memory()` from the registry with `MEMORY_MODE=fake` while they build. Do not tell those phases to import this folder directly.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `src/lib/memory/index.ts` | Default-export satisfying `MemoryPort` |
| `src/lib/memory/decisions.ts` | `recordDecision` |
| `src/lib/memory/postmortem.ts` | `generateAndWrite` |
| `src/lib/memory/epcr.ts` | `draftPcr`, `renderPcrText` |

Create the four files above. Do not edit `seed.ts`. Do not edit `package.json`.

### Ports consumed

| Port | Used for | Set this to build in isolation |
|---|---|---|
| `EmbeddingsPort` | Vectors on decisions and live postmortems | `EMBEDDINGS_MODE=fake` |
| `EventsPort` | `decision` and `pcr` / `write` events | `EVENTS_MODE=fake` |
| `LlmPort` | Live postmortem narrative only | `LLM_MODE=fake` |

```
EMBEDDINGS_MODE=fake EVENTS_MODE=fake LLM_MODE=fake MEMORY_MODE=real
RETRIEVAL_MODE=fake GRAPH_MODE=fake VOICE_MODE=fake
```

`recordDecision` must contain **no** LLM call. Rationale extraction belongs to PHASE-13. If the caller hands you an empty rationale, throw; do not ask a model to invent one.

This phase writes to Atlas, so it needs a reachable cluster. It does not need PHASE-07's retrieval module to pass its own criteria. The PRD line "a live postmortem is retrievable by `fanOut` immediately after being written" is verified when `RETRIEVAL_MODE=real` and PHASE-07 exists; under fakes, assert the document is in `postmortems` with `origin: "live"`, a non-empty `embeddedText`, and `embedding.length === env.embeddingDim` — that is what makes a later real `fanOut` able to see it. Do not import `@/lib/retrieval`.

### Port implemented

`MemoryPort`, default-exported from `src/lib/memory/index.ts` (registry path `@/lib/memory`).

## Files to Create

### `src/lib/memory/decisions.ts`

```ts
import type { CallTypeFamily, DecisionDoc, DecisionOutcome } from "@/lib/contracts";

export interface RecordDecisionInput {
  incidentId: string;
  displayId: string;
  utterance: string;
  actionChosen: string;
  rationale: string;
  optionsConsidered?: string[];
  outcome?: DecisionOutcome;
  protocolConflict?: boolean;
  callTypeFamily: CallTypeFamily;
}

export class EmptyRationaleError extends Error {
  constructor(message = "rationale must be a non-empty string") {
    super(message);
    this.name = "EmptyRationaleError";
  }
}

/** Throws EmptyRationaleError before any database or embedding call. */
export function assertRationale(rationale: string): string;

export function embeddedTextFor(input: Pick<RecordDecisionInput, "utterance" | "actionChosen" | "rationale">): string;

export async function recordDecision(input: RecordDecisionInput): Promise<DecisionDoc>;
```

`assertRationale` trims the string. If the result is `""`, throw `EmptyRationaleError`. Call it as the first line of `recordDecision`, before `embeddings()`, before `col()`, before `events()`. Whitespace-only (`"   "`, `"\n"`) is empty. This is the in-process half of Critical Rule 4; PHASE-02's validator is the in-database half.

`embeddedTextFor` concatenates `utterance`, `actionChosen`, and `rationale` with separators (newlines or `" | "` — pick one and use it consistently) so the rationale is a substring of `embeddedText`. The dashboard and retrieval debugging both read `embeddedText`; a vector with no rationale in the text is how a "decision plus a reason" becomes a reason that cannot be retrieved.

`recordDecision` then:

1. `assertRationale(input.rationale)` and the same non-empty check on `actionChosen`.
2. `embeddedText = embeddedTextFor(input)`.
3. `embedding = await (await embeddings()).embedOne(embeddedText, "document")`. Assert `embedding.length === env.embeddingDim` and throw naming both numbers on mismatch.
4. Insert one `DecisionDoc` with `outcome` defaulting to `"pending"`, `protocolConflict` defaulting to `false`, `optionsConsidered` defaulting to `[]`, `t: new Date()`.
5. Emit through `EventsPort`:

```ts
await (await events()).emit({
  kind: "decision",
  incidentId: input.incidentId,
  payload: {
    decisionId: String(insertedId),
    actionChosen: input.actionChosen,
    rationaleRecorded: true,
    protocolConflict: input.protocolConflict ?? false,
  },
});
```

Optionally also emit `{ kind: "write", payload: { collection: DECISIONS, count: 1 } }` so the dashboard counter moves. Do not emit on the throw path.

Return the inserted document (include `insertedId` only if you add it as a local field — `DecisionDoc` has no `_id` in the contract, so do not widen the exported type).

**Never seed, upsert-on-incidentId, or delete other decisions.** Each call inserts exactly one document. The `decisions` collection stays empty until something calls this function, which during the demo is the voice path.

This file must not import `llm` or call `LlmPort`. `rg -n "llm\\(|from \\\"@/lib/llm\\\"|from '@/lib/llm'" src/lib/memory/decisions.ts` returns nothing.

### `src/lib/memory/postmortem.ts`

```ts
import type { IncidentDoc, DecisionDoc, PostmortemDoc } from "@/lib/contracts";

export function wordCount(s: string): number;

/** Observed transition from the live record, never from _groundTruth. */
export function whatChangedFrom(incident: IncidentDoc, decisions: DecisionDoc[]): string;

export async function generateAndWrite(
  incident: IncidentDoc,
  decisions: DecisionDoc[],
): Promise<PostmortemDoc>;
```

`whatChangedFrom` produces a short string such as `"unconscious or unresponsive → cardiac arrest"` using `labelFor` on codes that appear in **timeline text, decision `actionChosen`, or `cad.initialCallType`**. It must not read `incident._groundTruth`. Strip `_groundTruth` at the start of `generateAndWrite` (`const { _groundTruth: _, ...safe } = incident`) so a later edit cannot accidentally interpolate it. For a live demo incident there should be no ground truth anyway (`isLive: true`).

`generateAndWrite`:

1. Call `(await llm()).text(prompt, { maxWords: 110 })` with a prompt that asks for first-person-plural past tense, 60–110 words (contract allows 40–200; stay inside 60–110 to match the seeded band), the dispatch label, what the crew recorded, and the lessons. Instruct the model: never invent vitals, drug doses, or patient identifiers; never use `_groundTruth` fields. Pass the timeline and the decision `actionChosen` + `rationale` pairs as the only clinical content.
2. If the fake LLM is in use, you still get a templated string — that is enough. Post-filter `/\d+\s*(mg|mcg|mL|g)\b/i` the same way PHASE-06 does; on a hit, replace the narrative with a deterministic template over `labelFor(cad.initialCallType)`, borough, and the first decision rationale.
3. Clamp word count into 40–200. Below 40, append a single logistics sentence. Above 200, truncate on a sentence boundary.
4. `lessons` is a short string array derived from decision rationales (one lesson per decision, capped at three) plus a fallback `"record the rationale before closing the call"` when there were no decisions.
5. `origin: "live"`. `callTypeFamily: incident.callTypeFamily`. `displayId: incident.displayId`. `severityDelta: 0` for live calls — you do not know the CAD final severity, and inventing one from ground truth is forbidden. A live postmortem with `severityDelta: 0` is honest; a copied historical delta is not.
6. `embeddedText` is the narrative plus `whatChanged` plus lessons joined. Embed with `"document"`. Assert dimension.
7. Insert one `PostmortemDoc`. Emit `{ kind: "pcr", payload: { postmortemId, preview } }` where `preview` is the first 40 words, and `{ kind: "write", payload: { collection: POSTMORTEMS, count: 1 } }`.

Idempotency for live writes: `deleteMany({ incidentId, origin: "live" })` immediately before insert so a retried `close_call` does not duplicate. Never delete `origin: "seeded"` or `"curated"`.

### `src/lib/memory/epcr.ts`

These types live in this file. They are not in `contracts.md`. Do not add them to `contracts.md` unless another phase needs them — PHASE-11's `close_call` returns `{ postmortemId, pcrPreview }` as a string, so a string renderer is the integration surface.

Eight sections, medic-expected order (NEMSIS-style PCR, with Clinical rationale as the BlackBox section):

```ts
export const PCR_SECTION_ORDER = [
  "Response",
  "Scene",
  "Patient",
  "Situation",
  "Assessment",
  "Treatments",
  "Clinical rationale",
  "Disposition",
] as const;

export type PcrSectionTitle = (typeof PCR_SECTION_ORDER)[number];

export interface PcrSection {
  title: PcrSectionTitle;
  body: string;
}

export interface PcrDraft {
  incidentId: string;
  displayId: string;
  ref: string;
  unsigned: true;          // literal true — a draft is never final
  sections: PcrSection[];  // length 8, in PCR_SECTION_ORDER
}

export function draftPcr(
  incident: IncidentDoc,
  decisions: DecisionDoc[],
  postmortem?: Pick<PostmortemDoc, "narrative" | "whatChanged" | "lessons">,
): PcrDraft;

export function renderPcrText(draft: PcrDraft): string;
```

Section bodies, all derived from the live record:

| Section | Content |
|---|---|
| Response | `ref`, `labelFor(cad.initialCallType)`, dispatch area, borough, unit if present, incident datetime |
| Scene | Dispatch area and borough only. No invented address. |
| Patient | `"Not recorded in BlackBox."` BlackBox does not store patient identifiers and must not invent them. |
| Situation | Medic timeline entries (`source === "medic"`), concatenated and capped. If empty, `"Not recorded."` |
| Assessment | Agent and system timeline notes that are not readbacks, capped. If empty, `"Not recorded."` |
| Treatments | `decisions[].actionChosen` as a list. If none, `"None recorded."` |
| Clinical rationale | Each decision as `"${actionChosen} — ${rationale}"`. **Non-empty when `decisions.length >= 1`.** If there are no decisions, `"No decisions recorded."` |
| Disposition | `"Transfer of care; unsigned draft only."` plus `postmortem.whatChanged` when provided |

`draftPcr` must return all eight sections in that order. `sections.map(s => s.title)` equals `[...PCR_SECTION_ORDER]`.

`renderPcrText` **begins** with an unsigned-draft header on its own line, then a blank line, then the sections as `## {title}\n{body}`. Required header text, exact:

```
UNSIGNED DRAFT — not a legal patient care report
```

The rendered string must not contain the whole words `final`, `signed`, or `complete` as a status claim (case-insensitive). `"Transfer of care"` is fine. A heading `"Final impression"` is not — do not add one.

Neither `draftPcr` nor `renderPcrText` reads `_groundTruth`. Neither interpolates `finalCallType`, `finalSeverityLevelCode`, or `incidentCloseDatetime`. `rg -n "_groundTruth" src/lib/memory/epcr.ts src/lib/memory/postmortem.ts src/lib/memory/decisions.ts` returns nothing.

The close path PHASE-11 will run is `generateAndWrite` then `draftPcr` then `renderPcrText`. That sequence must finish in under 8 seconds with fake LLM and fake embeddings (it should be well under 1 second). Do not add retries or sleeps.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `recordDecision` throws `EmptyRationaleError` on `rationale: ""` and on a whitespace-only rationale, and the throw happens before any Mongo insert (verified by counting `decisions` documents for that `incidentId` remaining unchanged)
- [ ] `recordDecision` throws on an empty `actionChosen` as well
- [ ] A valid call inserts exactly one document whose `embeddedText` contains the rationale as a substring
- [ ] `embeddedText` contains `utterance`, `actionChosen`, and `rationale`
- [ ] The inserted `embedding` has length `env.embeddingDim`
- [ ] A `decision` event is emitted through `EventsPort` on every successful write (with `EVENTS_MODE=fake`, `__drain()` contains one `kind: "decision"` event)
- [ ] `src/lib/memory/decisions.ts` contains no LLM call and does not import `@/lib/llm` or `llm()` from the registry
- [ ] **Parallel-safe criterion:** with `EMBEDDINGS_MODE=fake EVENTS_MODE=fake LLM_MODE=fake`, `recordDecision` and `generateAndWrite` succeed against Atlas (or, if collections are missing, fail with a clear Mongo error rather than a missing-module error from another phase)
- [ ] `generateAndWrite` produces a postmortem with `origin: "live"`, word count between 40 and 200 inclusive, and `embedding.length === env.embeddingDim`
- [ ] The live narrative is first-person plural past tense in the same 60–110 target band as the seeded corpus, and does not match `/\d+\s*(mg|mcg|mL|g)\b/i`
- [ ] `whatChanged` is derived from the observed live record and never from `_groundTruth`
- [ ] Re-running `generateAndWrite` for the same `incidentId` leaves exactly one `origin: "live"` postmortem for that id and does not delete `origin: "seeded"` or `"curated"` rows
- [ ] Under `RETRIEVAL_MODE=fake`, the written live postmortem is present in `postmortems` with a non-empty `embeddedText`; do not import `@/lib/retrieval` to prove this
- [ ] `draftPcr` returns exactly eight sections whose titles equal `PCR_SECTION_ORDER` in order
- [ ] The Clinical rationale section body is non-empty and contains the rationale text when at least one decision was passed in
- [ ] `renderPcrText` output starts with `UNSIGNED DRAFT — not a legal patient care report` and is never marked final
- [ ] Neither the postmortem narrative nor the ePCR text contains any value read from `_groundTruth`
- [ ] `rg -n "_groundTruth" src/lib/memory/decisions.ts src/lib/memory/postmortem.ts src/lib/memory/epcr.ts` returns nothing
- [ ] The sequence `generateAndWrite` → `draftPcr` → `renderPcrText` completes in under 8 seconds with all consumed ports faked
- [ ] This phase does not create or edit `scripts/integrate.ts`, `scripts/smoke.ts`, or any file under `app/api/`

## Verification

PowerShell users: set env vars with `$env:EMBEDDINGS_MODE='fake'` on a preceding line rather than the inline prefix shown here.

```bash
npm run typecheck

EMBEDDINGS_MODE=fake EVENTS_MODE=fake LLM_MODE=fake npx tsx -e "
import { recordDecision, EmptyRationaleError } from './src/lib/memory/decisions';
import { generateAndWrite } from './src/lib/memory/postmortem';
import { draftPcr, renderPcrText, PCR_SECTION_ORDER } from './src/lib/memory/epcr';
import { col } from './src/lib/db/client';
import { DECISIONS, POSTMORTEMS } from './src/lib/contracts';
import { events } from './src/lib/registry';
import { readFileSync } from 'fs';

const incidents = JSON.parse(readFileSync('fixtures/incidents.json','utf8'));
const inc = { ...incidents[0], timeline: incidents[0].timeline ?? [], isLive: true };
delete inc._groundTruth;

const before = await col(DECISIONS).countDocuments({ incidentId: inc.incidentId });
let threw = false;
try { await recordDecision({ incidentId: inc.incidentId, displayId: inc.displayId, utterance: 'x', actionChosen: 'deferred airway', rationale: '   ', callTypeFamily: inc.callTypeFamily }); }
catch (e) { threw = e instanceof EmptyRationaleError || e.name === 'EmptyRationaleError'; }
const afterFail = await col(DECISIONS).countDocuments({ incidentId: inc.incidentId });
console.log('empty rationale throws', threw, 'no insert', afterFail === before);

const d = await recordDecision({
  incidentId: inc.incidentId, displayId: inc.displayId,
  utterance: 'skipping the supraglottic, family reports recent neck surgery',
  actionChosen: 'deferred supraglottic airway',
  rationale: 'family reports recent neck surgery',
  callTypeFamily: inc.callTypeFamily,
});
console.log('embedded has rationale', d.embeddedText.includes('family reports recent neck surgery'));
console.log('dim', d.embedding.length);

const pm = await generateAndWrite(inc, [d]);
console.log('origin', pm.origin, 'words', pm.narrative.trim().split(/\s+/).length);
console.log('whatChanged', pm.whatChanged);

const draft = draftPcr(inc, [d], pm);
console.log('sections', draft.sections.map(s => s.title).join('|') === PCR_SECTION_ORDER.join('|'));
const clinical = draft.sections.find(s => s.title === 'Clinical rationale');
console.log('clinical has rationale', !!clinical && clinical.body.includes('family reports recent neck surgery'));
const text = renderPcrText(draft);
console.log('unsigned header', text.startsWith('UNSIGNED DRAFT — not a legal patient care report'));
console.log('not final', !/\bfinal\b/i.test(text.split('\n')[0]));

await col(DECISIONS).deleteMany({ incidentId: inc.incidentId });
await col(POSTMORTEMS).deleteMany({ incidentId: inc.incidentId, origin: 'live' });
process.exit(0);
"

rg -n "_groundTruth" src/lib/memory/decisions.ts src/lib/memory/postmortem.ts src/lib/memory/epcr.ts
rg -n "llm\(|@/lib/llm" src/lib/memory/decisions.ts
```

## Handoff Note

Announce that `recordDecision` rejects empty rationale in process, that live postmortems write with `origin: "live"`, and that `renderPcrText` starts with the unsigned-draft header. PHASE-11 should call these functions rather than re-implementing inserts. PHASE-16's smoke depends on exactly one decision with a non-empty rationale and exactly one live postmortem after `close_call`.
