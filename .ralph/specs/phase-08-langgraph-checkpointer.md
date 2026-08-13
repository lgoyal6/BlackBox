# Phase 08 — LangGraph, MongoDB Checkpointer, and the Readback Interrupt

**Status:** PENDING
**Tasks:** US-014, US-015, US-016
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 90 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Implement `GraphPort` as a LangGraph 1.4.9 `StateGraph` checkpointed with `MongoDBSaver` 1.4.0, using `incidentId` as `thread_id`. Wire the memory nodes that make this a recall system rather than a dictation tool — signature match, a spoken brief, and a plan that excludes known-bad paths from a forty-document seed corpus — and park the graph at `interrupt()` for aviation-style readback so a killed process can resume from Atlas.

## Why This Phase Is The Stage Moment

The kill-and-resume in front of the judges is the one part of the demo that is hard to fake. It only works if every invocation uses `MongoDBSaver` and never `MemorySaver`. With an in-memory saver, `interrupt()` still appears to work inside one process and the crash recovery fails on stage with no warning. That is the highest-consequence rule in this build.

This phase does **not** own fake-to-real cutover or the end-to-end smoke. PHASE-16 owns `scripts/integrate.ts` and `scripts/smoke.ts` and will *call* `npm run drill`. Do not create those files, do not flip `GRAPH_MODE` for the whole app, and do not write a second smoke path.

## Do This First (before writing any node)

**Confirm v1 export names against the installed types.** Packages are pinned in `overview.md`: `@langchain/langgraph` 1.4.9 and `@langchain/langgraph-checkpoint-mongodb` 1.4.0. Newer LangGraph docs also mention `StateSchema` and `ReducedValue`. This project locked `interrupt()`, `Command`, `StateGraph`, and `Annotation` — use those if 1.4.9 exports them. Open `node_modules/@langchain/langgraph/dist/index.d.ts` (or the package's exported `.d.ts`) and copy the names that are actually there. Do not guess, and do not copy a v0 import path from memory. If `isInterrupted` is not exported, read `result.__interrupt__` instead. Log the confirmed names in `.ralph/agents.md` under Technical Decisions.

Documented 1.4 surfaces this spec will use once types confirm them:

```ts
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
```

`interrupt()` **re-executes the interrupted node from the top** on resume. Everything before the `interrupt()` call runs a second time. Put no writes, no `EventsPort.emit`, and no non-idempotent I/O before `interrupt()`. This is the single most expensive gotcha in this phase.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §7 — `IncidentState`, `PendingReadback`, `ReadbackConfirmation`, `InterruptPayload`. `thread_id` **is** `incidentId`.
- `.ralph/contracts.md` §4 — `GRAPH_NODE_ORDER`, `GraphNode`. Node names in the graph must be these strings, because the dashboard footer and the fake graph walk the same list.
- `.ralph/contracts.md` §6 — `SignatureMatch`, `PlanResult`, `ExcludedPath`, `Hit`. Do not redefine them.
- `.ralph/contracts.md` §9 — `GraphPort` (`start`, `resume`, `state`) and the registry's fixed real path `@/lib/graph`.
- `.ralph/contracts.md` §14 — demo corpus. `SEED_TARGET` is 40. Plan exclusion must work against that size, not a warehouse.
- `.ralph/overview.md` — LangGraph diagram, the stage moment, Critical Rules 2 and 3, Scope Guardrail (the agent never proposes treatment).
- `.ralph/specs/phase-16-integration-cutover.md` — so you do not duplicate `integrate` / `smoke`. This phase owns the drill; 16 calls it.
- `src/lib/fakes/graph.ts` (PHASE-01) — first pass returns a `readback` interrupt at `readback_gate`; after resume it returns `null`. Match that shape so PHASE-11's `confirm_readback` works against either implementation.
- `fixtures/incidents.json` and `fixtures/hits.json` — `graph:local` and the plan node are verified against these with retrieval faked.
- `src/lib/db/client.ts` — pass the shared `getClient()` into `MongoDBSaver`. Do not construct a second `MongoClient`.
- `src/lib/db/indexes.ts` is PHASE-02. It deliberately does **not** create `checkpoints` or `checkpoint_writes`. The saver creates and indexes those on `setup()`.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `src/lib/graph/index.ts` | Default export satisfying `GraphPort` |
| `src/lib/graph/state.ts` | `Annotation.Root` (or the 1.4.9 equivalent) for `IncidentState` |
| `src/lib/graph/checkpointer.ts` | `MongoDBSaver` factory plus `setup()` |
| `src/lib/graph/compile.ts` | Node wiring, `compile({ checkpointer })` |
| `src/lib/graph/nodes.ts` | All graph nodes |
| `src/lib/graph/wrap.ts` | Enter/exit `node` events; interrupt payload mapping |
| `scripts/run-graph-local.ts` | `npm run graph:local` |
| `scripts/kill-resume-drill.ts` | `npm run drill` |

Do not edit `package.json` — `"graph:local"` and `"drill"` already exist in `contracts.md` §12. Do not create `scripts/integrate.ts` or `scripts/smoke.ts`. Durable decision and postmortem writes go through `memory()` from the registry (`MemoryPort`, `MEMORY_MODE`). Do not import `@/lib/memory/decisions` directly.

### Ports consumed

| Port | Used for | Set this to build in isolation |
|---|---|---|
| `RetrievalPort` | `signatureMatch`, `failureMemory`, `reclassPrior` | `RETRIEVAL_MODE=fake` |
| `LlmPort` | Brief prose and plan step phrasing | `LLM_MODE=fake` |
| `EventsPort` | `node` enter/exit, `readback`, `retrieval` | `EVENTS_MODE=fake` |

```
GRAPH_MODE=real
RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake
EMBEDDINGS_MODE=fake VOICE_MODE=fake
```

With those fakes this phase needs no embedding key, no ElevenLabs key, and no other phase's code. It does need Atlas, because `MongoDBSaver` is the deliverable. The fake retrieval returns hits from `fixtures/hits.json`; the plan node must produce `excludedPaths` from those hits so exclusion is testable on a forty-document (or fixture-sized) corpus.

### Port implemented

`GraphPort`, **default-exported from `src/lib/graph/index.ts`** — the registry's fixed real path `@/lib/graph` (`contracts.md` §9).

```ts
import type { GraphPort } from "@/lib/ports";

const graph: GraphPort = { start, resume, state };
export default graph;
```

Use `satisfies GraphPort` or an explicit annotation so a signature drift is a compile error. A named export, or the object living only in `compile.ts` with no re-export, produces a silent `FAKE PORT` fallback.

## Files to Create

### `src/lib/graph/state.ts`

```ts
import { Annotation } from "@langchain/langgraph";
import type { IncidentState } from "@/lib/contracts";

export function concatReducer<T>(left: T[], right: T | T[]): T[];

export const IncidentAnnotation: ReturnType<typeof Annotation.Root>;
export type GraphState = typeof IncidentAnnotation.State;
```

Confirm `Annotation.Root` against installed 1.4.9 types. If 1.4.9 exports a different state helper and not `Annotation`, use that helper and log the substitution in `agents.md`. Do not invent a third style.

Reducers, from `contracts.md` §7:

| Field | Reducer |
|---|---|
| `timeline` | concat |
| `nodeTrail` | concat |
| `retrieved` | concat |
| `decisionsRecorded` | concat |
| every other `IncidentState` field | last-write-wins (replace) |

`concatReducer` must accept a single item or an array so a node can return `{ timeline: [entry] }` without wrapping. Default empty arrays for the concat fields so the first write is not `concat(undefined, x)`.

### `src/lib/graph/checkpointer.ts`

```ts
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import type { MongoClient } from "mongodb";

export function createCheckpointer(client: MongoClient): MongoDBSaver;
export async function ensureCheckpointer(client: MongoClient): Promise<MongoDBSaver>;
```

Construct with the documented `MongoDBSaverParams` from 1.4.0:

```ts
new MongoDBSaver({
  client,                                    // getClient() from @/lib/db/client
  dbName: env.mongodbDb,                     // same database as the rest of the app
  checkpointCollectionName: CHECKPOINTS,     // "checkpoints"
  checkpointWritesCollectionName: CHECKPOINT_WRITES, // "checkpoint_writes"
})
```

Call `await saver.setup()` inside `ensureCheckpointer` before the first compile. The 1.4.0 README states you need to call `.setup()` the first time; it is idempotent and creates the compound indexes the saver queries by. Cache the saver on `globalThis` in development the same way PHASE-01 caches the Mongo client, or hot reload will create a second saver against a second implied setup.

**Never import or construct `MemorySaver`.** Not in tests, not in `graph:local`, not behind a flag. `rg MemorySaver src/lib/graph scripts/run-graph-local.ts scripts/kill-resume-drill.ts` must return nothing, and a repo-wide grep is an acceptance criterion.

### `src/lib/graph/wrap.ts`

```ts
import type { GraphNode, InterruptPayload, IncidentState } from "@/lib/contracts";

export function threadConfig(incidentId: string): { configurable: { thread_id: string } };

export function wrapNode(
  name: GraphNode,
  fn: (state: IncidentState) => Promise<Partial<IncidentState>>,
): (state: IncidentState) => Promise<Partial<IncidentState>>;

export function interruptPayloadFromInvokeResult(result: unknown): InterruptPayload | null;
```

`threadConfig` returns `{ configurable: { thread_id: incidentId } }` and nothing else. Mixing in a different id is how resume silently starts a new empty thread.

`wrapNode` emits `{ kind: "node", payload: { node, phase: "enter" } }` **after** the node body returns, and `{ phase: "exit" }` as well — except for `readback_gate` and `await_input`, which must not emit anything until **after** `interrupt()` has returned. Implement that by making those two nodes call `interrupt()` themselves (unwrapped for the pre-interrupt region) rather than putting emit inside `wrapNode` before `fn()`. A wrapper that always emits on enter will duplicate `node` events on every resume, because the node restarts from the top.

`interruptPayloadFromInvokeResult` reads `__interrupt__` from the invoke result (LangGraph 1.x returns `{ value }` objects in that array). If the value already matches `InterruptPayload`, return it. If the array is missing or empty, return `null`. Do not invent a third payload shape.

### `src/lib/graph/nodes.ts`

```ts
export async function triage(state: IncidentState): Promise<Partial<IncidentState>>;
export async function signatureMatchNode(state: IncidentState): Promise<Partial<IncidentState>>;
export async function brief(state: IncidentState): Promise<Partial<IncidentState>>;
export async function plan(state: IncidentState): Promise<Partial<IncidentState>>;
export async function readbackGate(state: IncidentState): Promise<Partial<IncidentState>>;
export async function executeRecord(state: IncidentState): Promise<Partial<IncidentState>>;
export async function verify(state: IncidentState): Promise<Partial<IncidentState>>;
export async function recordDecisionNode(state: IncidentState): Promise<Partial<IncidentState>>;
export async function awaitInput(state: IncidentState): Promise<Partial<IncidentState>>;
export async function postmortemNode(state: IncidentState): Promise<Partial<IncidentState>>;
```

Node names passed to `addNode` must be the `GraphNode` strings in `GRAPH_NODE_ORDER`. Function names in TypeScript may differ; the graph key may not.

#### `triage`

No LLM call. Load is already in state from `start()`. Set `status` to `"en_route"` if it was `"dispatched"`, append `"triage"` to `nodeTrail`, and stop. Do not read `_groundTruth`. Do not call `retrieval()` or `llm()`.

#### `signatureMatchNode`

Build an `IncidentDoc`-shaped object from state (the fields `signatureMatch` needs: `incidentId`, `displayId`, `cad`, `callTypeFamily`, `timeline`) and call `(await retrieval()).signatureMatch(incident)`. Write `signature` onto state. Concatenate returned `hits` onto `retrieved`. Emit a `retrieval` event with the query string you used.

A `null` signature is a first-class result. Do not coerce it into a fake match.

#### `brief`

Fifty-five words or fewer, spoken prose, no raw dispatch codes. Use `labelFor` for every call type. When `state.signature` is `null`, the brief **must contain the exact phrase** `new signature, no prior history`. When it is populated, mention `signature.displayId` and the summary, then optionally one line from `(await retrieval()).reclassPrior(cad.initialCallType, cad.dispatchArea)` when that returns non-null.

You may call `llm().text` with `maxWords: 55`, or template the string deterministically. Either way, post-filter: if the output contains a bare code from `CODE_LABELS` as a whole word, replace it with `labelFor(code)` before returning. Count words on whitespace and truncate rather than shipping a 56th word.

#### `plan`

This node is what makes the second demo call a memory demo. It must produce a non-empty `excludedPaths` on a SICK-to-cardiac incident when failure memory exists, **including on a 40-document templated seed** (`SEED_TARGET = 40`). Do not require a large corpus, a high raw-score floor, or LLM-quality narratives. If `failureMemory` returns hits, map them. If a `callTypeFamily` filter returns empty, retry once with no family filter and log that you did. If the mapped list is still empty, log a warning containing `excludedPaths empty` — do not throw, and do not invent a path.

```ts
const hits = await (await retrieval()).failureMemory(query, state.callTypeFamily);
```

`query` is built from `labelFor(cad.initialCallType)`, borough, dispatch area, and recent medic timeline text — the same class of string `signatureMatch` uses, so fake retrieval's substring match against `fixtures/hits.json` actually returns rows. Map each hit to `ExcludedPath`:

| Field | Source |
|---|---|
| `path` | `hit.title` (the failed action / what-changed line) |
| `why` | `hit.spoken` or `hit.text`, capped so the array stays readable |
| `sourceDisplayId` | `hit.displayId` if present, otherwise `"unknown"` |
| `costMinutes` | `hit.meta.costMinutes` if it is a number, otherwise `null` |

`steps` are **logistics and documentation only**. They may include "confirm receiving facility status", "read back the stated dose", "record the airway decision", "ask for the rationale before writing". They may never include a treatment, a dose, or a diagnosis. After the LLM (or template) returns steps, **filter in code**, not only in the prompt:

```ts
const DOSE = /\d+\s*(mg|mcg|mL|g)\b/i;
steps = steps.filter((s) => !DOSE.test(s.action) && !DOSE.test(s.why));
```

That regex is the same one PHASE-06 uses on narratives. A step that survives the prompt but matches this pattern is dropped. If filtering removes everything, replace with a single logistics step: `{ action: "record the medic's stated actions and rationale", why: "documentation only" }`.

#### `readbackGate`

The human-in-the-loop gate. **No emit, no write, no retrieval, no LLM before `interrupt()`.**

```ts
export async function readbackGate(state: IncidentState): Promise<Partial<IncidentState>> {
  const pending: PendingReadback = state.pendingReadback ?? derivePending(state);
  const payload: InterruptPayload = {
    type: "readback",
    incidentId: state.incidentId,
    ...pending,
  };
  const confirmation = interrupt(payload) as ReadbackConfirmation;
  // resume continues here — now it is legal to emit
  return {
    lastConfirmation: confirmation,
    pendingReadback: null,
  };
}
```

`derivePending` reads the latest medic timeline entry and copies drug/dose/route if they are already in `state.pendingReadback`. If nothing is pending, still interrupt with a documentation readback of that utterance so `graph:local` and the drill always have a gate to park at. Do not call an LLM to compose the readback text — PHASE-11's `propose_readback` is deterministic string formatting, and this node should use `state.pendingReadback.readbackText` when present.

On resume, emit `{ kind: "readback", payload: { state: confirmation.confirmed ? "confirmed" : "rejected", readbackText: pending.readbackText } }`.

#### `executeRecord` / `verify`

Simulate execution (real execution is on the cut list). Append a timeline entry `source: "system"` describing that the stated action was recorded, not performed by the agent. `verify` checks `lastConfirmation.verbatimOk === true`; if not, append a system note and still continue — the medic owns the clinical call. No LLM.

#### `recordDecisionNode`

Append `state.pendingReadback?.utterance ??` the latest medic line onto `decisionsRecorded`. The durable insert is `(await memory()).recordDecision(...)`. Do not import PHASE-09 files directly. Skipping the port and writing here would double-insert on a resume.

#### `awaitInput`

Same interrupt rule as the readback gate: nothing before `interrupt()`.

```ts
const value = interrupt({
  type: "await_input",
  incidentId: state.incidentId,
  status: state.status,
} satisfies InterruptPayload);
```

On resume, if `value` is `{ closeRequested: true }` or state already has `closeRequested`, set `closeRequested: true`. If `value` is a string or `{ text: string }`, append a medic timeline entry.

#### `postmortemNode`

On `closeRequested`, call `(await memory()).generateAndWrite(incidentId)` then `draftPcr`. Append `"postmortem"` to `nodeTrail` and emit a `pcr` event with a ≤40-word preview from the draft. The durable `PostmortemDoc` write lives in PHASE-09 behind `MemoryPort`; this node is the caller.

### `src/lib/graph/compile.ts`

```ts
export async function getCompiledGraph(): Promise<CompiledStateGraph /* use the 1.4.9 compiled type */>;
```

Wire in `GRAPH_NODE_ORDER` order:

```
START → triage → signature_match → brief → plan → readback_gate
      → execute_record → verify → record_decision
      → (closeRequested ? postmortem : await_input)
await_input → (closeRequested ? postmortem : plan)
postmortem → END
```

The conditional edges after `record_decision` and `await_input` are how a multi-turn call loops without restarting triage. Confirm `addConditionalEdges` against installed types; the predicate reads `state.closeRequested`.

Cache the compiled graph next to the saver. Compiling on every `start()` is wasted work and can race `setup()`.

### `src/lib/graph/index.ts`

```ts
export async function start(incidentId: string): Promise<{ interrupt: InterruptPayload | null }>;
export async function resume(incidentId: string, value: unknown): Promise<{ interrupt: InterruptPayload | null }>;
export async function state(incidentId: string): Promise<{
  values: Partial<IncidentState>;
  next: string[];
  checkpointCount: number;
}>;
```

`start` loads the incident with `PUBLIC_INCIDENT_PROJECTION` (`{ _groundTruth: 0 }`). If Atlas has no row, fall back to `fixtures/incidents.json` so `graph:local` works before PHASE-04. Invoke the compiled graph with the initial `IncidentState` and `threadConfig(incidentId)`. Return `{ interrupt: interruptPayloadFromInvokeResult(result) }`.

`resume` invokes with `new Command({ resume: value })` and the **same** `threadConfig(incidentId)`. That `Command` constructor is the documented 1.4 resume input; confirm it against types. Do not pass a plain object and hope.

`state` calls `compiled.getState(threadConfig(incidentId))`. Map `snapshot.values` and `snapshot.next`. `checkpointCount` is `col(CHECKPOINTS).countDocuments({ thread_id: incidentId })` (the saver stores `thread_id` as a field — confirm on the first write; if the field is nested, count what is actually there and log it). While interrupted, `next` must include the pending node (`readback_gate` or `await_input`).

### `scripts/run-graph-local.ts`

Thin CLI over `GraphPort`. Already wired as `npm run graph:local`.

| Flag | Effect |
|---|---|
| `--incident-id=<id>` | Use this id; default to the first `UNC` fixture |
| `--auto-confirm` | On a `readback` interrupt, resume with `{ confirmed: true, verbatimOk: true }`; on `await_input`, resume with `{ closeRequested: true }` so the run reaches `postmortem` |
| `--print-state` | Dump `values.nodeTrail`, `values.brief`, `values.plan`, `next`, `checkpointCount` after each invoke |

Print the interrupt payload, then the brief, then `plan.excludedPaths`. Exit non-zero if `--auto-confirm` finishes without `"postmortem"` in `nodeTrail`, or if `brief` contains a raw dispatch code.

### `scripts/kill-resume-drill.ts`

This is the stage moment, automated. Already wired as `npm run drill`.

1. `start(incidentId)` and wait until the returned interrupt is `type: "readback"` (or `state().next` includes `readback_gate`).
2. Snapshot `state().values.timeline`, `state().values.signature`, and counts of `decisions` and `remediations`.
3. Spawn a **child process** (`tsx scripts/kill-resume-drill.ts --resume-only --incident-id ...` or an equivalent worker flag) so the resume runs in a fresh Node isolate with a new compiled graph and a new saver constructed from `getClient()`. The parent may `process.exit` the child after the interrupt, or the script can be two invocations; the point is that resume does not share the in-memory compiled graph from the first invoke.
4. In the fresh process, `resume(incidentId, { confirmed: true, verbatimOk: true })`.
5. Assert timeline length is at least the snapshot length, `signature` is still present (or still null — whichever it was), and `decisions` / `remediations` counts are **identical** to the snapshot. That last assertion is how you prove no duplicated side effects.
6. Print `PASS` and exit 0, or `FAIL` with the mismatch and exit 1.

`--incident-id` selects the thread. `--stop-before-resume` parks after the interrupt so PHASE-16 can target an existing incident. Do not construct a `MemorySaver` to "make the unit test faster."

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `src/lib/graph/index.ts` default-exports an object satisfying `GraphPort`, verified by a type-level annotation, and `GRAPH_MODE=real` resolves to it through the registry with no `FAKE PORT` warning
- [ ] Export names `interrupt`, `Command`, `StateGraph`, and the state helper actually used were confirmed against installed `@langchain/langgraph` 1.4.9 types (logged in `agents.md` if they differ from this spec)
- [ ] The graph compiles with `MongoDBSaver` using `getClient()`, `checkpointCollectionName: CHECKPOINTS`, and `checkpointWritesCollectionName: CHECKPOINT_WRITES`, and `setup()` is called before the first invoke
- [ ] `rg MemorySaver` across the repository returns zero occurrences
- [ ] Every `invoke` / `getState` uses `{ configurable: { thread_id: incidentId } }`
- [ ] `timeline`, `nodeTrail`, `retrieved`, and `decisionsRecorded` use concat reducers; other fields are last-write-wins
- [ ] A full `--auto-confirm` call produces a `nodeTrail` containing every name in `GRAPH_NODE_ORDER`
- [ ] After one run, `checkpoints` and `checkpoint_writes` are non-empty for that `thread_id`
- [ ] Every node other than `readback_gate` and `await_input` emits a `node` event on enter and on exit; those two emit nothing before `interrupt()` returns
- [ ] `triage` performs no LLM call (verified by running with `LLM_MODE=real` and no `OPENAI_API_KEY` through triage only, or by inspection that `triage` never awaits `llm()`)
- [ ] `brief` is 55 words or fewer, contains `new signature, no prior history` when signature is null, and contains no raw dispatch code (`UNC`, `EDP`, `SICK`, `ARREST`, `CARD` as whole words)
- [ ] **Parallel-safe criterion:** with `RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake`, `plan.excludedPaths` is non-empty for a SICK-to-cardiac fixture incident whose failure-memory query overlaps `fixtures/hits.json`
- [ ] Every `excludedPath` has a `why`, a `sourceDisplayId`, and `costMinutes` as a number or `null`
- [ ] `plan` logs a warning containing `excludedPaths empty` when the mapped list is empty, and does not throw
- [ ] No `plan.steps` entry matches `/\d+\s*(mg|mcg|mL|g)\b/i` after the code filter, even if the LLM (or fake LLM) emitted one
- [ ] Plan exclusion does not require more than `SEED_TARGET` (40) seeded documents — no score floor, no minimum corpus size, no LLM-narrative requirement
- [ ] A run reaches `readback_gate` and `start()` / the first invoke returns an interrupt payload with `type: "readback"`
- [ ] While interrupted, `state(incidentId).next` includes `readback_gate` (or `await_input` at that gate)
- [ ] Killing the process while interrupted, starting a fresh process, and `resume` with `Command` continues from the gate with `timeline` and `signature` intact
- [ ] Decision and remediation collection counts after a kill-and-resume run equal the counts from an uninterrupted run
- [ ] `npm run drill` exits 0 on success
- [ ] `npm run graph:local -- --auto-confirm` completes a full call whose `nodeTrail` includes `postmortem`
- [ ] No file in `src/lib/graph/` references `_groundTruth`: `rg -n "_groundTruth" src/lib/graph` returns nothing
- [ ] No file in this phase's ownership imports `@/lib/memory/` or `@/lib/retrieval/` (retrieval goes through `registry`)

## Verification

PowerShell users: set env vars with `$env:GRAPH_MODE='real'` on a preceding line rather than the inline prefix shown here.

```bash
npm run typecheck

# Confirm exports against installed types before relying on this spec's names.
npx tsx -e "
import * as lg from '@langchain/langgraph';
for (const k of ['interrupt','Command','StateGraph','Annotation','START','END','isInterrupted','MemorySaver'])
  console.log(k, typeof (lg as any)[k]);
"

# Port resolves; no FAKE PORT.
GRAPH_MODE=real RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake \
  npx tsx -e "
import { graph } from './src/lib/registry';
const g = await graph();
console.log(['start','resume','state'].every(k => typeof (g as any)[k] === 'function'));
"

# MemorySaver must not exist in this phase or anywhere else.
rg MemorySaver --glob '!node_modules/**' --glob '!.ralph/**'

# Full local run with all other ports faked.
GRAPH_MODE=real RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake \
  npx tsx scripts/run-graph-local.ts --auto-confirm --print-state

# Kill-and-resume in a fresh process.
GRAPH_MODE=real RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake \
  npm run drill

# Plan filter and empty-corpus warning are unit-checkable without a live call.
npx tsx -e "
import { plan } from './src/lib/graph/nodes';
"
```

After `--auto-confirm`, manually confirm: `brief` word count ≤ 55, `plan.excludedPaths.length >= 1` on the cardiac fixture, `nodeTrail` includes every `GRAPH_NODE_ORDER` name, and `col('checkpoints').countDocuments({ thread_id }) > 0`.

## Handoff Note

Announce that `@/lib/graph` default-exports a working `GraphPort` on `MongoDBSaver`, that `npm run drill` exits 0, and the confirmed 1.4.9 export names. PHASE-11's `confirm_readback` and PHASE-16's smoke both resume this interrupt; PHASE-16 must not reimplement the drill.
