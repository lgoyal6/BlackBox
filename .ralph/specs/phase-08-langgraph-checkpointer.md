# Phase 08 — LangGraph, MongoDB Checkpointer, and the Readback Interrupt

**Status:** PENDING
**Tasks:** US-014, US-015, US-016
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 90 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Build the LangGraph state machine that runs a call end to end, checkpointed to MongoDB Atlas with `MongoDBSaver`, with two `interrupt()` gates — the aviation-style readback and the between-turns park — and expose it as `GraphPort`. Prove the kill-and-resume works from a text-mode drill before any voice layer exists.

## Why This Phase Carries The Demo

Two things live here and neither can be cut:

1. **`signature_match` and the failure-exclusion logic in `plan`** are what make this a memory project rather than a runbook lookup. If `plan` is not visibly declining a course of action because memory says it went badly before, this is a dictation tool with extra infrastructure.
2. **The kill-and-resume.** Mid-demo, with the agent waiting on a confirmation, the process is killed in front of the judges and restarted, and the call continues. Fifteen seconds, thematically perfect, and the only part of the demo that is hard to fake.

Everything in this spec is downstream of protecting those two.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §7 — `IncidentState`, `PendingReadback`, `ReadbackConfirmation`, `InterruptPayload`. `thread_id` **is** `incidentId`.
- `.ralph/contracts.md` §6 — `Hit`, `SignatureMatch`, `PlanResult`, `ExcludedPath`, `ReclassPrior`.
- `.ralph/contracts.md` §4 — `GraphNode`, `GRAPH_NODE_ORDER`, `labelFor()`, `callTypeFamily()`.
- `.ralph/contracts.md` §8 — the `node`, `readback`, `decision`, `retrieval`, and `checkpoint` event payloads the dashboard renders.
- `.ralph/contracts.md` §9 — `GraphPort`, and the registry's fixed real path.
- `.ralph/overview.md` — The Stage Moment, Critical Rules 2 and 3, the Scope Guardrail, the graph diagram.
- `src/lib/fakes/graph.ts` (PHASE-01) — the scripted walk your real implementation replaces. PHASE-11 and PHASE-14 are built against it, so keep the observable behaviour identical.
- `node_modules/@langchain/langgraph/dist/*.d.ts` — **read the installed types before writing any import.** See the note below.

### Confirm the API against the installed package, do not guess

This project pins `@langchain/langgraph` **1.4.9** and `@langchain/langgraph-checkpoint-mongodb` **1.4.0**. You need `StateGraph`, `Annotation`, `START`, `END`, `interrupt`, and `Command`. The v1 barrel is expected to re-export all of them, and the checkpointer package is expected to export `MongoDBSaver`.

**If any name does not resolve, grep the package's own type declarations rather than guessing a plausible alternative.** The same applies to the shape of the interrupt result on `invoke()`, the generic parameter order of `interrupt<TPayload, TResume>()`, the `MongoDBSaver` constructor options, and the property that carries a pending interrupt on `getState()`. Guessing any of these costs a compile cycle and, worse, can produce something that type-checks and silently does the wrong thing. Ten minutes reading `.d.ts` files at the start of a ninety-minute phase is the cheapest ten minutes in the build.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `src/lib/graph/state.ts` | `Annotation.Root` state definition and reducers |
| `src/lib/graph/checkpointer.ts` | `MongoDBSaver` construction, cached |
| `src/lib/graph/trace.ts` | Node wrappers that emit `node` events and append to `nodeTrail` |
| `src/lib/graph/nodes/*.ts` | One file per node, ten in total |
| `src/lib/graph/build.ts` | `StateGraph` wiring and compile |
| `src/lib/graph/index.ts` | Default export satisfying `GraphPort` |
| `scripts/run-graph-local.ts` | Drive a full call from the CLI with no voice layer |
| `scripts/kill-resume-drill.ts` | Automate the stage moment |

`npm run graph:local` and `npm run drill` already point at those scripts (`contracts.md` §12). Do not edit `package.json`.

### Ports consumed

| Port | Used for | Set this to build in isolation |
|---|---|---|
| `RetrievalPort` | `signature_match`, `plan`, `brief` | `RETRIEVAL_MODE=fake` |
| `LlmPort` | `plan` only | `LLM_MODE=fake` |
| `EventsPort` | `node`, `readback`, `decision`, `retrieval` events | `EVENTS_MODE=fake` |

The PHASE-01 retrieval fake is built for this: `signatureMatch` returns `null` when the query contains `"transfer"` and a populated match otherwise, so both the "new signature" and "we have seen this" branches of `brief` are exercisable before PHASE-07 exists.

**The one thing this phase cannot fake is the checkpointer.** Critical Rule 2 forbids an in-memory saver, so this phase needs a reachable Atlas cluster with the `checkpoints` and `checkpoint_writes` collections (the saver creates them). It needs no other phase's *code*, which is what parallel-safe means here. If `incidents` is empty because PHASE-04 has not run, `run-graph-local.ts --from-fixture` seeds a single incident from `fixtures/incidents.json`.

### Port implemented

`GraphPort`, **default-exported from `src/lib/graph/index.ts`** — the registry's fixed real path `@/lib/graph` (`contracts.md` §9).

```ts
const graph: GraphPort = { start, resume, state };
export default graph;
```

### Never construct a `MemorySaver`

Not in the graph, not in a script, not in a test, not temporarily while debugging. With an in-memory saver, `interrupt()` still appears to work inside a single process, every local test passes, and the kill-and-resume fails on stage with no prior warning. This is the highest-consequence rule in the build and there is a grep-based acceptance criterion for it.

## Files to Create

### `src/lib/graph/state.ts`

```ts
export const IncidentAnnotation = Annotation.Root({
  incidentId: Annotation<string>,
  displayId: Annotation<string>,
  ref: Annotation<string>,
  status: Annotation<IncidentStatus>,
  cad: Annotation<CadFields>,
  callTypeFamily: Annotation<CallTypeFamily>,

  timeline:          Annotation<TimelineEntry[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  nodeTrail:         Annotation<GraphNode[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  retrieved:         Annotation<Hit[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  decisionsRecorded: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),

  signature: Annotation<SignatureMatch | null>,
  plan: Annotation<PlanResult | null>,
  brief: Annotation<string | null>,
  pendingReadback: Annotation<PendingReadback | null>,
  lastConfirmation: Annotation<ReadbackConfirmation | null>,
  closeRequested: Annotation<boolean>,
});

export type GraphState = typeof IncidentAnnotation.State;
```

Four channels concat; every other channel is last-write-wins, which is the `Annotation` default. Confirm the exact `Annotation` call form against the installed types — the bare-channel and options-object forms differ.

Add a compile-time guard so the graph state cannot silently drift from the contract:

```ts
// Fails to compile if GraphState stops satisfying the contract's IncidentState.
const _contractCheck: IncidentState = undefined as unknown as GraphState;
void _contractCheck;
```

Also define and export the resume payload, validated with Zod v4 inside the interrupting nodes. `GraphPort.resume(incidentId, value: unknown)` types the value as `unknown`, so this shape is PHASE-08's to define and PHASE-11 reads it from here:

```ts
export const ResumeInput = z.union([
  z.object({ kind: z.literal("readback"), confirmed: z.boolean(), verbatimOk: z.boolean() }),
  z.object({
    kind: z.literal("turn"),
    text: z.string().optional(),
    source: z.enum(["medic", "agent", "system"]).optional(),
    closeRequested: z.boolean().optional(),
    pendingReadback: z.custom<PendingReadback>().optional(),
  }),
]);
export type ResumeInput = z.output<typeof ResumeInput>;
```

Parse it inside the node and throw a message naming the expected shape on mismatch. A malformed resume value that silently no-ops is indistinguishable on stage from a broken checkpointer.

### `src/lib/graph/checkpointer.ts`

```ts
export function getCheckpointer(): MongoDBSaver;
```

Construct it with the **shared client** from `@/lib/db/client` — never a second `MongoClient`, which would double the connection pool and make the Atlas metrics view misleading during the demo.

| Option | Value |
|---|---|
| client | `getClient()` |
| database name | `env.mongodbDb` |
| checkpoint collection | `CHECKPOINTS` (`"checkpoints"`) |
| writes collection | `CHECKPOINT_WRITES` (`"checkpoint_writes"`) |

Confirm the exact option names against `@langchain/langgraph-checkpoint-mongodb` 1.4.0's types before writing them. Cache the saver on `globalThis` for the same reason `db/client.ts` caches the client: Next.js hot reload re-evaluates modules and a module-level `let` accumulates savers until Atlas refuses connections, around the fifth edit, with an error message that does not mention hot reload.

**`thread_id` is the `incidentId`.** One thread per call:

```ts
export const threadConfig = (incidentId: string) => ({ configurable: { thread_id: incidentId } });
```

That single decision is what makes resume-after-crash a one-liner: there is nothing to look up, the call's identity *is* the thread's identity.

### `src/lib/graph/trace.ts`

```ts
export function withTrace(node: GraphNode, fn: NodeFn): NodeFn;
export function withTraceAfterResume(node: GraphNode, fn: NodeFn): NodeFn;
export type NodeFn = (state: GraphState) => Promise<Partial<GraphState>>;
```

`withTrace` emits a `node` event with `phase: "enter"`, runs the node, emits `phase: "exit"`, and merges `{ nodeTrail: [node] }` into the returned partial state. The dashboard footer highlights the active node from exactly these events.

`withTraceAfterResume` is the variant for the two interrupting nodes: it emits **nothing** before calling the node function and emits only the `exit` event afterwards. The reason is the re-execution rule below. Wrap `readback_gate` and `await_input` with this one and every other node with `withTrace`.

Note that `nodeTrail` is appended through the **returned partial state**, never by a side-effecting call. State updates only materialize when a node returns, so an interrupted node that never returns contributes nothing — which is exactly the behaviour you want.

### The re-execution gotcha (read this before writing either interrupt node)

**On resume, LangGraph re-executes the interrupted node from the top.** Everything written before the `interrupt()` call runs a second time. This costs an hour if you learn it by debugging.

Three rules follow, and they are not negotiable:

1. **No writes, no emits, no side effects before `interrupt()` in that node.** Put every side effect after the interrupt returns, or make it idempotent.
2. **The dashboard's "awaiting readback" event is emitted by the caller** — `start`/`resume` in `index.ts`, from the returned interrupt payload — not from inside the node. Emitting it inside the node would fire a duplicate amber pill on every resume.
3. **The same rule applies to `await_input`.** It is the more frequently hit of the two, since the graph parks there between every medic turn.

There is a grep-based acceptance criterion: neither interrupt node file may contain the string `emit(` at all.

### `src/lib/graph/nodes/`

Every node has the signature `(state: GraphState) => Promise<Partial<GraphState>>`, returns only the channels it changes, and imports cross-phase functionality **only through `@/lib/registry`**.

#### `triage.ts`

Deterministic. **No LLM call.** Loads the incident with `PUBLIC_INCIDENT_PROJECTION`, derives `callTypeFamily`, `displayId`, and `ref` from the contract helpers, sets `status`, and appends one `system` timeline entry.

The reason for no LLM here is latency: `triage` is on the critical path to the first spoken word, and a model call adds a second to the exact moment the ElevenLabs interaction-design criteria measure. Everything this node does is a lookup or a string format.

Throw a message naming `--from-fixture` if the incident is not found, so a missing PHASE-04 ingest diagnoses itself.

#### `signature-match.ts`

Calls `(await retrieval()).signatureMatch(incident)`. Sets `signature`, concats any returned `hits` onto `retrieved`, and emits a `retrieval` event with the query and hits. `null` is a normal, expected result on call one — do not treat it as an error and do not retry with a lower threshold.

#### `brief.ts`

**Hard budget: under fifteen seconds of speech, roughly 40 words.** Build it deterministically from a template with no LLM call. A template you can read in the repo is a brief you can rehearse; an LLM brief is different every run and cannot be.

Compose in this priority order, stopping as soon as the word budget is reached:

| Order | Clause | Source |
|---|---|---|
| 1 | What was dispatched, in plain language | `labelFor(cad.initialCallType)` — **never a raw code** |
| 2 | Either the signature summary with its `displayId`, or "new signature, no prior history" | `state.signature` |
| 3 | The single highest-value failure | top hit from `failureMemory` |
| 4 | The reclassification prior line, optional | `reclassPrior(initialCallType, dispatchArea)` |

Clause 4 drops first when the budget is tight, which is correct — it is the least actionable of the four.

Do not let this node grow. A brief that runs thirty seconds is one the medic talks over, and the entire design premise is that it is short enough to listen to while driving. Assert the word count in the node and log a warning above 45 words.

#### `plan.ts`

The failure-exclusion node. Produces `PlanResult` per `contracts.md` §6.

`excludedPaths` is the point of the entire project. Each entry is a course of action the agent is **not** taking because memory says it went badly before, carrying the incident it learned that from and what it cost:

```ts
{ path: string; why: string; sourceDisplayId: string; costMinutes: number | null }
```

Build it from two inputs, merged:

1. `(await retrieval()).failureMemory(query, family)` over the seeded corpus. `path` from the hit's `title`, `why` from its `spoken`, `sourceDisplayId` from `displayId`, `costMinutes` from `meta.costMinutes`.
2. A direct `find({ incidentId, outcome: "failure" })` on `remediations` **for this call**. This is what makes the demo's "second approach works" beat emerge from data instead of being hardcoded: something failed earlier in this same call, `verify` recorded it, and the next `plan` pass declines it by name.

**`excludedPaths` must be non-empty on demo call two.** Log a warning whenever it is empty so the problem surfaces during rehearsal rather than on stage.

The scope guardrail is enforced here (Critical Rule 3). `steps` are **logistics and documentation actions only** — routing, receiving-facility selection, notification, what to record, what to re-check. **Never treatments, drugs, or doses.** Two layers:

- The prompt says so explicitly, in those words.
- The node filters the model's output, dropping any step whose `action` or `why` matches `/\d+\s*(mg|mcg|mL|g)\b/i`, and logs each dropped step.

The filter is not paranoia. This is precisely where an LLM tries to be helpful and drifts over the line, and a judge who hears the agent suggest a dose has already stopped listening to the rest of the pitch. If you want a second belt, add a short deny-list of administration verbs; the dose regex is the required one.

This is the only node that calls `LlmPort`. Use `llm.json()` with a schema matching `PlanResult` so the output is structured rather than parsed out of prose.

#### `readback-gate.ts`

```ts
export async function readbackGate(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.pendingReadback) return {};                       // pass through unchanged
  const confirmation = interrupt({
    type: "readback",
    incidentId: state.incidentId,
    ...state.pendingReadback,
  }) as ReadbackConfirmation;
  return { lastConfirmation: confirmation, pendingReadback: null };
}
```

The payload is the `readback` arm of `InterruptPayload` from `contracts.md` §7. Nothing executes before `interrupt()` except the pass-through check, which is a pure read. Confirm whether `interrupt` takes generic parameters in 1.4.9 and prefer them over the cast if it does.

#### `await-input.ts`

A second `interrupt()` that parks the graph between medic turns, with the `await_input` arm of `InterruptPayload`. Validate the resume value with `ResumeInput` and translate it into `{ timeline: [...], closeRequested, pendingReadback }`.

Two consequences, both good, and worth saying out loud in the pitch:

- The graph becomes a persistent, resumable conversation driver rather than a one-shot pipeline, which is exactly the "persistent context" theme of the hackathon.
- **Every park is a checkpoint in Atlas**, so the kill-and-resume works at any point in the call, not only during a readback. That turns the stage moment from a single scripted beat into a property of the system.

It also fits Next.js route handlers perfectly: every invocation is short and all durable state lives in Atlas, so nothing depends on a long-lived process.

#### `execute-record.ts`

Simulates execution. Real execution is cut-list item #1 and taking that cut is correct — no judge will check whether an ambulance was actually rerouted, and building real execution buys nothing the demo shows.

Records the action, a simulated `durationSeconds`, and writes a `remediations` document with a **real** outcome: `failure` when the chosen step matches a path that `failureMemory` already flagged (the agent had to take it anyway), `success` otherwise. Derive `durationSeconds` deterministically from the action string so rehearsals are identical.

**Set `costMinutes: null` on these live remediations.** `costMinutes` is derived from real timing against a family median; a simulated action has no such number, and inventing one here is exactly the thing PHASE-06 goes out of its way to avoid.

Write with a deterministic `_id` of `` `${incidentId}:execute_record:${passIndex}` `` and use `replaceOne` with `upsert: true`. If the process dies after the write but before the checkpoint lands, the node re-runs on resume and upserts over itself instead of inserting a duplicate. This is what makes the "no duplicate side effects" acceptance criterion hold.

#### `verify.ts`

Reads back the remediation just written and checks its outcome. When it was a failure, clear `plan` so the graph takes another `plan` pass; `plan` will find the fresh failure through its direct `remediations` query and exclude it by name. The demo's "second approach works" beat then happens naturally, from data, rather than being scripted.

#### `record-decision.ts`

Appends to `decisionsRecorded` and emits the `decision` event (`decisionId`, `actionChosen`, `rationaleRecorded`, `protocolConflict`).

**It does not write to the `decisions` collection.** The durable write belongs to PHASE-09's `recordDecision`, invoked from PHASE-11's `record_decision` tool route where the utterance actually arrives and the rationale has been separated out. The ownership table permits importing only from PHASE-01, and there is no `MemoryPort` in the registry, so PHASE-08 has no legal way to call PHASE-09 today. Do not import across the boundary to make it work. If the graph should own that write, add a `MemoryPort` to `contracts.md` §9 and a resolver to the registry first, log it in `agents.md`, and only then wire it up.

#### `postmortem.ts`

Sets `status: "closed"`, emits its node events, and ends. Generation and the `postmortems` write belong to PHASE-09's `generateAndWrite`, called from `POST /api/tools/close_call`, for the same ownership reason as above.

### `src/lib/graph/build.ts`

```ts
export function buildGraph(): CompiledGraph;   // exact compiled type from the installed package
```

Wire the shape from `overview.md`:

```
START → triage → signature_match → brief → plan → readback_gate
      → execute_record → verify → record_decision → (conditional)
```

The conditional edge out of `record_decision`: when `closeRequested` is true go to `postmortem` and then `END`; otherwise go to `await_input`, and from `await_input` back to `plan`.

Compile with `{ checkpointer: getCheckpointer() }`. Cache the compiled graph in a module-level singleton — compiling per request is wasted milliseconds on the latency-judged path.

### `src/lib/graph/index.ts`

```ts
async function start(incidentId: string): Promise<{ interrupt: InterruptPayload | null }>;
async function resume(incidentId: string, value: unknown): Promise<{ interrupt: InterruptPayload | null }>;
async function state(incidentId: string): Promise<{ values: Partial<IncidentState>; next: string[]; checkpointCount: number }>;
```

- `start` invokes the compiled graph with `threadConfig(incidentId)` and an initial state built from the incident document, then extracts any pending interrupt from the invoke result. Confirm the exact property carrying it against the installed types; do not guess a name.
- `resume` invokes with a `Command` carrying the resume value.
- `state` reads `getState(threadConfig(incidentId))` for `values` and `next`, and counts checkpoints with `col(CHECKPOINTS).countDocuments({ thread_id: incidentId })`. Confirm the stored field name by printing one checkpoint document after the first run rather than assuming it — `run-graph-local.ts` should print it once for exactly this reason.
- **`start` and `resume` emit the `readback` event** with state `awaiting` when they return a `readback` interrupt, and `confirmed`/`rejected` when a resume carries a confirmation. This is the caller-side emit required by the re-execution rule.
- They also emit a `checkpoint` event carrying the current count, which is what the dashboard's checkpoint counter reads. Point at that counter immediately before killing the process.

### `scripts/run-graph-local.ts`

Drives a full call from the CLI with no voice layer, so the graph is debuggable without ElevenLabs anywhere in the loop. **Build this before touching voice.** A text-mode rehearsal of the stage moment is worth more than a prettier voice, and it is the only way to iterate on the graph in seconds rather than minutes.

| Flag | Effect |
|---|---|
| `--incident-id=<id>` | Which call to run; required unless `--from-fixture` |
| `--from-fixture` | Upsert one incident from `fixtures/incidents.json` with a `local-` prefixed id and `isLive: true`, so local drills never collide with demo data |
| `--auto-confirm` | Automatically resume every readback with `{ confirmed: true, verbatimOk: true }` |
| `--stop-before-resume` | Run to the first interrupt, print the payload, and exit 0 without resuming |

Print, in order: the node trail as it advances, the brief with its word count, the plan `steps`, every `excludedPath` with its `sourceDisplayId` and `costMinutes`, the interrupt payload, and the checkpoint count. On the first run also print one raw checkpoint document so the `thread_id` field name is confirmed rather than assumed.

### `scripts/kill-resume-drill.ts`

Automates the stage moment. Sequence:

1. Run an **uninterrupted baseline** on a throwaway incident id and record the final `decisionsRecorded` length and the `remediations` count for that incident.
2. Spawn a child process running `run-graph-local.ts --stop-before-resume` on the drill incident and wait until it reports the interrupt.
3. **`SIGKILL` the child.** Not a graceful shutdown — the point is that nothing gets a chance to flush.
4. Start a **fresh** process and resume the same `incidentId`.
5. Assert: the run continues from the gate; `timeline` and `signature` are intact; `nodeTrail` continues rather than restarting; and the final `decisionsRecorded` length and `remediations` count match the baseline exactly.

Print a pass/fail line per assertion and exit non-zero on any failure. Rehearse it three times before the pitch, per `overview.md`.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `src/lib/graph/index.ts` default-exports an object satisfying `GraphPort`, verified by a type-level annotation, and `GRAPH_MODE=real` resolves to it through the registry with no `FAKE PORT` warning
- [ ] `GraphState` satisfies the contract's `IncidentState` — enforced by the compile-time guard in `state.ts`, not by inspection
- [ ] **No `MemorySaver` anywhere:** `rg -n "MemorySaver" src worker app scripts` returns nothing
- [ ] The compiled graph is constructed with `MongoDBSaver` using the shared client from `@/lib/db/client`, and no second `MongoClient` is constructed in `src/lib/graph/`
- [ ] **Parallel-safe criterion:** with `RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake`, `npm run graph:local -- --from-fixture --auto-confirm` completes a full call, printing a `nodeTrail` that visits all eight non-interrupt nodes, with no other phase's code present
- [ ] `timeline`, `nodeTrail`, `retrieved`, and `decisionsRecorded` accumulate across nodes; every other channel is last-write-wins — verified by inspecting the final state after a multi-pass run
- [ ] After a run, `col("checkpoints").countDocuments({ thread_id: incidentId })` is greater than zero and increases across successive parks
- [ ] `triage` issues no LLM call: the node completes with `LLM_MODE=real` and no `OPENAI_API_KEY` set
- [ ] The `brief` string is 40 words or fewer on both the signature-found and signature-`null` branches, and never contains a raw call type code
- [ ] With the retrieval fake returning `null` from `signatureMatch`, the brief contains the phrase "new signature, no prior history"
- [ ] `plan.excludedPaths` is non-empty when `failureMemory` returns hits, each entry carrying a `sourceDisplayId`, and a warning is logged when it is empty
- [ ] `plan` drops every step matching `/\d+\s*(mg|mcg|mL|g)\b/i` — verified by feeding a fake LLM response containing "administer 1 mg epinephrine" and asserting it is absent from `steps` and that the drop was logged
- [ ] **No side effects before either `interrupt()`:** `rg -n "emit\(" src/lib/graph/nodes/readback-gate.ts src/lib/graph/nodes/await-input.ts` returns nothing
- [ ] `readback_gate` passes through unchanged, returning no interrupt, when `pendingReadback` is `null`
- [ ] `readback_gate` returns `{ lastConfirmation, pendingReadback: null }` after resume
- [ ] `await_input` throws a message naming the expected shape when handed a resume value that fails `ResumeInput` parsing
- [ ] **Kill-and-resume:** `npm run drill` passes — the process is `SIGKILL`ed while interrupted, a fresh process resumes the same `incidentId`, and the run continues from the gate with `timeline` and `signature` intact
- [ ] **No duplicate side effects after resume:** the final `decisionsRecorded` length and the `remediations` document count for the drill incident are identical to the uninterrupted baseline
- [ ] `execute_record` writes `costMinutes: null` on every live remediation
- [ ] Every node emits a `node` event on enter and exit except the two interrupt nodes, which emit only on exit
- [ ] `npm run graph:local -- --stop-before-resume` exits 0 and prints an `InterruptPayload` whose `type` is `"readback"` or `"await_input"`

## Verification

PowerShell users: set env vars with `$env:RETRIEVAL_MODE='fake'` on preceding lines rather than the inline prefix shown here.

```bash
npm run typecheck

# Highest-consequence rule in the build.
rg -n "MemorySaver" src worker app scripts && echo "FAIL: in-memory saver present" || echo "ok"

# No side effects before either interrupt.
rg -n "emit\(" src/lib/graph/nodes/readback-gate.ts src/lib/graph/nodes/await-input.ts \
  && echo "FAIL: emit before interrupt" || echo "ok"

# Full parallel-safe run. Real Atlas for the checkpointer, fakes for everything else.
RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake EMBEDDINGS_MODE=fake \
  npm run graph:local -- --from-fixture --auto-confirm

# Park at the gate and inspect durable state.
RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake \
  npm run graph:local -- --from-fixture --stop-before-resume

npx tsx -e "
import g from './src/lib/graph/index';
import { col } from './src/lib/db/client';
import { CHECKPOINTS } from './src/lib/contracts';
const id = process.env.DRILL_ID;
const s = await g.state(id);
console.log('next', s.next, 'checkpoints', s.checkpointCount);
console.log('timeline entries', s.values.timeline?.length);
console.log('signature', s.values.signature ? s.values.signature.displayId : 'null');
console.log('nodeTrail', s.values.nodeTrail?.join(' -> '));
console.log('sample checkpoint doc keys', Object.keys((await col(CHECKPOINTS).findOne({})) ?? {}));
process.exit(0);
"

# The stage moment, automated. Run this three times.
npm run drill
npm run drill
npm run drill

# Dose filter, using a fake LLM response that tries to prescribe.
LLM_MODE=fake npx tsx -e "
import { plan } from './src/lib/graph/nodes/plan';
const out = await plan({ /* minimal state */ } as never);
const bad = out.plan?.steps.filter(s => /\d+\s*(mg|mcg|mL|g)\b/i.test(s.action + ' ' + s.why)) ?? [];
console.log('dose-bearing steps that survived the filter:', bad.length);
process.exit(bad.length ? 1 : 0);
"
```

## Handoff Note

Announce two things when this passes: that `GRAPH_MODE=real` resolves cleanly, and that `npm run drill` is green. PHASE-11's tool routes are written against `GraphPort` and PHASE-15 rehearses the kill-and-resume, so both are waiting on exactly those two signals.

Also announce the contract gap you hit: PHASE-08 cannot call PHASE-09's writers without a `MemoryPort` in the registry. Whoever wires `close_call` and `record_decision` needs to know that decision was already made here.
