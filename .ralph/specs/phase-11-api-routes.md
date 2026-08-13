# Phase 11 — Tool, Demo, and State API Routes

**Status:** PENDING
**Tasks:** US-021, US-022
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 40 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Implement every HTTP surface the voice agent, the operator, and the dashboard call: the seven `/api/tools/*` handlers the ElevenLabs agent invokes mid-call, the three `/api/demo/*` orchestration routes, and the two read routes (`/api/state/[incidentId]`, `/api/counters`) that bootstrap the dashboard.

**All route contracts, request/response shapes, and latency budgets are already specified in `contracts.md` §10. Implement them exactly; do not redesign them.** This spec adds the security, latency, and deletion-safety requirements that the table cannot express.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §10 — **the authority for every route in this phase.** Request shape, response shape, and latency budget per tool. Copy them literally.
- `.ralph/contracts.md` §1 and §13 — import rules (`@/lib/contracts`, `@/lib/ports`, `@/lib/registry`, `@/lib/db/client`, own files only), Zod v4 for every body, `z.output<typeof Schema>` as the handler parameter type.
- `.ralph/contracts.md` §5 — `IncidentDoc`, `DecisionDoc`, `PostmortemDoc`, and `PUBLIC_INCIDENT_PROJECTION`. Every agent-facing incident read must use that projection.
- `.ralph/contracts.md` §6 — `Hit`, `SPOKEN_WORD_CAP`. The `spoken` field is what the agent reads aloud.
- `.ralph/contracts.md` §8 — the events this phase emits: `status`, `voice`, `decision`, `readback`, `retrieval`, `pcr`, `checkpoint`.
- `.ralph/contracts.md` §9 — the ports this phase consumes and how the registry resolves them.
- `.ralph/overview.md` — Critical Rules 3, 4, 5, 6, 8; the file ownership table; the Cut List.
- `src/lib/contracts/api.ts` (PHASE-01) — the Zod schemas and request/response types already exist here. **Use the exported names PHASE-01 produced; never declare a second copy of a route type in this phase.**

## Parallel-Safe Contract

### Files this phase owns

From the ownership table in `overview.md`, PHASE-11 owns exactly:

- `app/api/tools/**`
- `app/api/demo/**`
- `app/api/state/**`
- `app/api/counters/**`

Shared helpers live in `app/api/tools/_lib/`. A folder whose name starts with `_` is a **private folder** in the App Router and is excluded from routing, so helper modules there cannot accidentally become endpoints.

### Ports consumed, and how to build with zero dependencies

| Port | Used by | Fake behaviour that makes this phase verifiable alone |
|---|---|---|
| `RetrievalPort` | `recall_memory`, `get_protocol` | Returns hits from `fixtures/hits.json` filtered by substring, with real RRF |
| `GraphPort` | `confirm_readback`, `/api/state/[incidentId]` | Walks `GRAPH_NODE_ORDER`, raises a `readback` interrupt at `readback_gate` |
| `EventsPort` | every write path | Appends to an in-memory array with a `__drain()` for assertions |
| `LlmPort` | `record_decision`, `close_call` background work | Templated deterministic strings, zero network |
| `EmbeddingsPort` | `record_decision`, `close_call` background work | `sha256` → deterministic unit vector, zero network |

Build and verify the whole phase with:

```
RETRIEVAL_MODE=fake GRAPH_MODE=fake EVENTS_MODE=fake LLM_MODE=fake EMBEDDINGS_MODE=fake
```

Every acceptance criterion below except the two marked *(needs Atlas)* passes in that configuration. Those two touch `incidents`, `decisions`, and the seeded corpus, so they need a database — but not another phase.

### Port implemented

**None.** This phase implements no port and therefore default-exports nothing to the registry. It is a pure consumer, which is why it can be built first among the parallel phases without blocking anyone.

### The two soft dependencies, and how to keep them from becoming a merge conflict

Two handlers need logic that the ownership table assigns to other phases and that is **not** exposed as a port:

| Need | Canonical owner | Path |
|---|---|---|
| Rationale extraction, `composeReadback` | PHASE-13 | `src/lib/voice/tools.ts` |
| Decision writer, postmortem + ePCR generation | PHASE-09 | `src/lib/memory/decisions.ts`, `postmortem.ts`, `epcr.ts` |

That is a genuine gap in the contract: the ports cover six boundaries and these two are not among them. Resolve it with the same pattern `registry.ts` already uses for a missing real module — a **soft dynamic import with a port-only fallback** — implemented once in `app/api/tools/_lib/deps.ts`, so no handler ever reaches across a phase boundary directly.

Rules for `_lib/deps.ts`:

- `await import("@/lib/voice/tools")` and `await import("@/lib/memory/decisions")` inside a `try`/`catch`. On failure, log once with a prefix containing `SOFT DEP MISSING` and use the fallback.
- **The imported module's return value is `unknown` and must be validated with a local Zod schema.** You cannot `import type` a module that may not exist yet — that fails `tsc` — so declare the shape locally and check it at runtime. This is exactly the situation `contracts.md` exists to prevent, so if this survives past the hackathon the correct fix is to add the extraction type to `contracts.md` §5 and log it in `agents.md`; today the runtime check is cheaper than a contract change that fourteen agents have to re-read.
- The three field names `actionChosen`, `rationale`, `optionsConsidered` and **the convention that `rationale` may be `null`** are load-bearing across this boundary. PHASE-13's spec states the same names for the same reason.
- The fallback must be a genuine working implementation, not a stub: extraction via `llm().json()` with a strict schema, the decision write via `embeddings().embedOne()` plus an `insertOne` into `col(DECISIONS)`. Any handler that throws because a soft dependency is absent makes this phase un-verifiable on its own, which defeats the point.

## Files to Create

### `app/api/tools/_lib/guard.ts`

Shared entry checks for `/api/tools/*`.

```ts
export type ToolName =
  | "recall_memory" | "get_protocol" | "log_timeline" | "propose_readback"
  | "confirm_readback" | "record_decision" | "close_call";

export function isToolName(s: string): s is ToolName;

export function jsonError(status: number, error: string): Response;

/** 401 when the header is absent or wrong; 500 when TOOL_SHARED_SECRET is unset. */
export function checkSecret(req: Request): { ok: true } | { ok: false; res: Response };

export async function parseBody<S extends z.ZodType>(
  req: Request, schema: S,
): Promise<{ ok: true; data: z.output<S> } | { ok: false; res: Response }>;

/** Runs fn, logs `[tool] <name> <ms>ms budget=<n>ms` and appends ` OVER BUDGET` when exceeded. */
export async function withTiming<T>(tool: ToolName, budgetMs: number, fn: () => Promise<T>): Promise<T>;
```

**The shared secret is mandatory on every `/api/tools/*` request.** Check `X-BlackBox-Secret` against `TOOL_SHARED_SECRET` and return `401` with `{ error: "unauthorized" }` otherwise. The tunnel URL is public for the duration of the event, and an unauthenticated write endpoint on a public URL is a bad idea even for one afternoon — `record_decision` writes to the clinical record and `close_call` generates and embeds a document.

Compare with `timingSafeEqual` from `node:crypto` when the byte lengths match, and return `401` when they do not. It costs two lines.

**If `TOOL_SHARED_SECRET` is unset or empty, return `500` with `{ error: "TOOL_SHARED_SECRET not configured" }` — never fall through to allow.** A misconfiguration that fails open on a public tunnel is the one failure you cannot see from the outside.

`withTiming`'s log line is a cross-phase interface: **PHASE-13's acceptance criteria grep the server log for `[tool] <name>` to prove the agent actually invoked tools rather than merely producing speech.** Do not remove or reformat it.

### `app/api/tools/_lib/deps.ts`

The soft-dependency shims described above, plus the small shared writers the handlers need.

```ts
export interface DecisionExtraction {
  actionChosen: string;
  rationale: string | null;        // null means the medic gave no reason. NEVER fabricate one.
  optionsConsidered: string[];
}

export async function extractRationale(utterance: string): Promise<DecisionExtraction>;

/** Deterministic. No LLM. Must byte-match PHASE-13's composeReadback. */
export function composeReadback(f: { drug?: string; dose?: string; route?: string; utterance?: string }): string;

/** Appends to incidents.timeline and bumps updatedAt. Never drops the utterance. */
export async function appendTimeline(incidentId: string, entry: TimelineEntry): Promise<void>;

/** Embeds and inserts one DecisionDoc. Throws if rationale is empty — the caller must check first. */
export async function writeDecision(
  incidentId: string, utterance: string, x: DecisionExtraction,
): Promise<{ decisionId: string }>;

/** Generates the narrative, embeds it, inserts a PostmortemDoc with origin: "live". */
export async function writePostmortem(incidentId: string): Promise<{ postmortemId: string; preview: string }>;
```

`composeReadback` produces exactly:

```
Confirm: <dose> of <drug>, <route>. Say confirm.
```

and when no drug/dose/route was supplied, exactly `Confirm: <utterance>. Say confirm.` **PHASE-13 owns a second copy of this function** (its `src/lib/voice/tools.ts` is the canonical one) and both specs pin the same assertion so the copies cannot drift:

```ts
composeReadback({ drug: "amiodarone", dose: "300 mg", route: "IV push" })
  === "Confirm: 300 mg of amiodarone, IV push. Say confirm."
```

Duplicating a function is normally wrong. Here the alternative is a cross-phase import of a module that may not exist yet, and the function is four lines of deterministic formatting pinned by an identical test in both phases. That is the cheaper of the two bad options.

`writeDecision` must set **both** `embedding` and `embeddedText` (`contracts.md` §13) and a non-empty `rationale` (Critical Rule 4, also enforced by PHASE-02's server-side validator). It throws on an empty rationale rather than writing a placeholder, because a placeholder rationale in the permanent record is the exact harm this project claims to prevent.

### `app/api/tools/[tool]/route.ts`

One dynamic handler dispatching on the tool name, matching `contracts.md` §10.

```ts
export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ tool: string }> },
): Promise<Response>;
```

**`params` is a `Promise` in Next.js 16** — `const { tool } = await ctx.params;`. Copying a Next 14/15 handler signature from memory fails to compile, and the error message points at the type of `params` rather than at the version change.

`runtime = "nodejs"` on every handler in this phase: the Mongo driver cannot run on the edge runtime.

Order of operations, no exceptions: `checkSecret` → `isToolName` (`404` with `{ error: "unknown tool" }`) → `parseBody` with that tool's Zod schema (`400` with `{ error: <message> }`) → `withTiming(tool, budget, handler)`. Validate before doing any work so a malformed body from a model that hallucinated an argument name costs nothing.

Errors are always `{ error: string }` with `400` validation / `401` bad secret / `404` not found / `500` internal (`contracts.md` §10). **Never return a 500 body containing a stack trace** — the response text goes to the voice model, which may read it aloud.

#### The seven handlers

Budgets are from `contracts.md` §10 and are **requirements, not aspirations,** because latency is an explicitly judged ElevenLabs criterion.

| `tool` | Request | Response | Budget |
|---|---|---|---|
| `recall_memory` | `{ incidentId, query }` | `{ summary: string; spoken: string; hits: Hit[] }` | **400 ms** |
| `get_protocol` | `{ incidentId, topic }` | `{ spoken: string; text: string; sectionTitle: string; pageStart: number }` | **400 ms** |
| `log_timeline` | `{ incidentId, text, source }` | `{ ok: true }` | 150 ms |
| `propose_readback` | `{ incidentId, utterance, drug?, dose?, route? }` | `{ readbackText: string }` | **300 ms**, synchronous, no LLM |
| `confirm_readback` | `{ incidentId, confirmed, verbatimOk }` | `{ ok: boolean; resumedAt: GraphNode \| null }` | 500 ms |
| `record_decision` | `{ incidentId, utterance }` | `{ ok: true; ack: string }` | 300 ms, write happens after the response |
| `close_call` | `{ incidentId }` | `{ postmortemId: string; pcrPreview: string }` | 8 s |

**`recall_memory`.** Read the incident with `PUBLIC_INCIDENT_PROJECTION`, call `retrieval().fanOut(query, { callTypeFamily })`, emit a `retrieval` event carrying the full hits so the dashboard's right pane renders scores, and return. `summary` is one sentence for the model's context; `spoken` is what the agent reads aloud and is composed from the top hits' `spoken` fields.

**Every `spoken` string returned to the voice agent is capped at `SPOKEN_WORD_CAP` (40) words, with the full `text` returned alongside for the dashboard.** Truncate defensively here even though PHASE-07 promises it, because the agent reads this aloud and a 200-word guideline chunk at TTS pace is ninety seconds of a medic listening to a robot while working a patient.

When `fanOut` returns nothing, return `{ summary: "no prior record", spoken: "No prior record of this pattern.", hits: [] }`. Do not synthesize a plausible-sounding memory. The empty case is the one a judge will deliberately trigger.

**`get_protocol`.** `fanOut(topic)` filtered to `source === "runbooks"`, take rank 1, return `spoken` / `text` / `sectionTitle` / `pageStart`. `404` with `{ error: "no protocol match" }` when there is no runbook hit. **`spoken` must begin with the section title** so the agent quotes with attribution — the scope guardrail permits quoting retrieved guidance *with attribution* and nothing else, and putting the attribution first in the string means the model cannot drop it without also dropping the content. Emit a `retrieval` event.

**`log_timeline`.** `$push` the entry onto `incidents.timeline`, `$set` `updatedAt`. When `source` is `medic` or `agent`, also emit a `voice` event with a `clock` of `mm:ss` elapsed since `cad.incidentDatetime` (which is why `/api/demo/fire` sets that field to now — see below). `404` when the incident does not exist.

**`propose_readback`.** Synchronous, deterministic, **no LLM in the path.** Call `composeReadback`, emit a `readback` event with `state: "awaiting"` and the exact text, return `{ readbackText }`. The agent must speak this verbatim on this turn, and an LLM can paraphrase a dose or round a number. Verbatim means verbatim, and the only way to guarantee it is that no model ever sees the string before the agent says it.

This handler **does not touch the graph.** The graph raises its own `interrupt()` at `readback_gate`; `confirm_readback` is what resumes it. Two writers to one gate is how you get a call that resumes twice.

**`confirm_readback`.** Call `graph().resume(incidentId, { confirmed, verbatimOk })`, then call `graph().state(incidentId)` and set `resumedAt` to `next[0]` when it is a member of `GRAPH_NODE_ORDER`, otherwise `null`. The extra `state()` call costs one checkpoint read and makes the response honest instead of guessed. Emit a `readback` event with `state: "confirmed"` or `"rejected"`, and a `checkpoint` event carrying `checkpointCount` from the same `state()` call — **this is where the dashboard's checkpoint counter gets its live value,** and that counter is what the operator points at immediately before the kill-and-resume.

**`record_decision`.** Return `{ ok: true, ack: "Recorded." }` **immediately**, then do the work in a detached task. Blocking the voice turn for a second of LLM extraction plus an embedding call is audible and reads as a slow agent, which is the criterion this phase is judged on.

The ack is deliberately one word: it is spoken, and anything longer wastes a turn.

The background task, in order:

1. `appendTimeline(incidentId, { source: "medic", text: utterance, kind: "narration" })`. **The utterance is never dropped.** The black box records everything; only the *decision document* requires a rationale.
2. `extractRationale(utterance)`.
3. If `rationale === null`: write **no** decision document, log a line containing `RATIONALE MISSING`, emit no `decision` event, and stop. Never invent a rationale. A fabricated one puts a made-up justification in the permanent clinical record, which is worse than a gap, and PHASE-02's validator would reject it anyway. The agent asking for the reason is a system-prompt behaviour (PHASE-13), not a tool response.
4. Otherwise `writeDecision(...)`, then emit a `decision` event with `rationaleRecorded: true` and `protocolConflict`.

`protocolConflict` defaults to `false` and **the LLM must not set it.** Labeling a medic's action as a protocol violation from one sentence is precisely the clinical judgment the scope guardrail forbids.

For the detached task use a plain promise with a `.catch()` that logs. We run a long-lived Node process (`next dev` / `next start`), not a serverless function that freezes after the response, so a detached promise completes. If you would rather use `after()` from `next/server`, confirm its export name and stability in the installed Next 16.3 typings first rather than from memory.

**`close_call`.** `writePostmortem(incidentId)`, set the incident `status: "closed"`, emit a `pcr` event with the preview and a `status` event with `closed`, return `{ postmortemId, pcrPreview }`. This is the only route allowed to exceed one second; the agent speaks a filler line ("drafting the report now") while it runs, so the 8 s budget is tolerable.

The postmortem **must** be written with `origin: "live"` so `/api/demo/reset` can delete it without touching the seeded corpus. Those two routes are coupled through this one field.

### `app/api/demo/fire/route.ts`

```ts
export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response>;
// Request  { pattern: "arrest" | "cardiac"; incidentId?: string }
// Response { incidentId: string; ref: string; displayId: string }
```

Pick a real ingested incident matching the requested pattern, clone its `cad` block into a **fresh live document** with a new `incidentId`, and insert it. That insert is what fires PHASE-12's change stream, which is the "phone rings by itself" beat. Real dispatch fields, live document.

| `pattern` | Source selection |
|---|---|
| `arrest` | `cad.initialCallType: "UNC"` with a true outcome of `ARREST` |
| `cardiac` | `cad.initialCallType: "SICK"` with a true outcome of `CARD` |

`incidentId` in the request overrides pattern selection and names the source incident to clone.

**On reading `_groundTruth` here.** Confirming the true outcome means querying `_groundTruth.finalCallType`, and Critical Rule 6 quarantines that field. Selection is not an agent read path, so this route may **query** it — but it must never copy it into the live document and never return it. The created document has no `_groundTruth` field at all, which is what keeps every retrieval path and graph node honest. There is an acceptance criterion for exactly that.

If querying a quarantined field from a route bothers you, the cheaper alternative is to match on `cad.initialCallType` and `callTypeFamily` only and accept a source whose true outcome you did not verify. The demo beat is identical; you lose the guarantee that call two is a genuine undertriage, which is the fact the pitch rests on. Prefer the query.

The new document:

| Field | Value | Why |
|---|---|---|
| `incidentId` | `live-<Date.now()>` | Matches the `contracts.md` §3 example; a new id every fire keeps `seq` counters clean |
| `displayId` | `toDisplayId(incidentId)` | Spoken aloud; never speak the full id |
| `ref` | `toRef(incidentId, now)` | The `YYMMDD-NNNN` dashboard header |
| `status` | `"dispatched"` | |
| `isLive` | `true` | The worker's change stream filters on this |
| `cad` | cloned from the source, **except `incidentDatetime` set to now** | |
| `cad.unit` | source value, or `"14B"` if absent | Synthesized for the demo; matches `reference.png` |
| `callTypeFamily` | `callTypeFamily(cad.initialCallType)` | |
| `timeline` | `[]` | |
| `_groundTruth` | **absent** | Critical Rule 6 |
| `createdAt` / `updatedAt` | now | The poll fallback's high-water mark reads `createdAt` |

`cad.incidentDatetime` must be **now**, not the historical timestamp. `ref` is derived from it, and `log_timeline`'s `clock` is elapsed time since it — keeping the original would render a header dated years ago and an elapsed timer measured in months.

Emit a `status` event immediately so the dashboard header populates even before the worker reacts.

`404` with `{ error: "no source incident for pattern <p> — run npm run ingest:incidents" }` when nothing matches. Naming the fix in the error text saves ten minutes of confusion twenty minutes before the pitch.

### `app/api/demo/close/route.ts`

```ts
// Request { incidentId } → Response { ok: true }
```

The operator's manual fallback for the transfer-of-care beat when the agent does not call `close_call` on its own. It performs the same work — set `status: "closed"`, emit a `status` event, generate the postmortem in the background — but returns only `{ ok: true }` per the contract. Existing because on stage, if the model skips the closing tool, the operator needs one button that continues the demo.

### `app/api/demo/reset/route.ts`

```ts
// Request {} → Response { deleted: Record<string, number> }
```

**Explicit, narrow filters. Nothing wildcard.**

| Collection | Filter | Never touched |
|---|---|---|
| `decisions` | `{}` | — (never seeded, Critical Rule 5) |
| `postmortems` | `{ origin: "live" }` | `seeded` and `curated` |
| `remediations` | `{ origin: "live" }` | `seeded` and `curated` |
| `events` | `{}` | — |
| `checkpoints` | `{}` | — |
| `checkpoint_writes` | `{}` | — |
| `incidents` | `{ isLive: true }` | historical incidents |
| `runbooks` | **not deleted** | the whole NASEMSO corpus |
| `_embed_cache` | **not deleted** | deleting it costs money and minutes of re-embedding |
| `_watch_state` | **not deleted** | PHASE-12's resume tokens and PHASE-10's `seq` counters |

Deleting the seed corpus twenty minutes before the pitch and having to re-embed it is a self-inflicted wound, which is why the filters are spelled out per collection instead of iterating a list. Return `deleted` keyed by collection name with the actual `deletedCount` from each operation so the operator can see what happened, and log one loud line with a timestamp — an unexplained empty dashboard should be diagnosable in ten seconds.

A stale resume token in `_watch_state` after deleting all events is fine: deleting documents does not invalidate an oplog token, and PHASE-12 handles an invalid token by restarting fresh.

Note the residual risk honestly: per `contracts.md` §10 the demo routes carry no shared-secret requirement, so on a public tunnel this endpoint is reachable by anyone who has the URL. The zero-cost mitigation is not pasting the tunnel URL anywhere public. Adding auth here would be a contract change and would break PHASE-15's scripts, so do not add it unilaterally.

### `app/api/state/[incidentId]/route.ts`

```ts
export const runtime = "nodejs";
export async function GET(
  req: Request,
  ctx: { params: Promise<{ incidentId: string }> },
): Promise<Response>;
// Response { values, next, checkpointCount }
```

A thin pass-through of `graph().state(incidentId)`. **`params` is a `Promise`.** `404` with `{ error: "unknown incident" }` when the graph has no thread for that id. This is the dashboard's fallback when SSE drops and the operator's fastest way to see which node the graph is parked on.

### `app/api/counters/route.ts`

```ts
export const runtime = "nodejs";
export async function GET(): Promise<Response>;
// Response { counts: Record<string, number>; checkpointCount: number; embedding: { provider, model, dim } }
```

`counts` covers `incidents`, `decisions`, `remediations`, `runbooks`, `postmortems`, `events`. `checkpointCount` is a count of `checkpoints`. `embedding` is `(await embeddings()).info()`.

Use `countDocuments({})` for the five small collections and `estimatedDocumentCount()` for `incidents`, which holds tens of thousands of rows and is only displayed as a total. Exact counts matter for the small ones because the reset acceptance criterion compares them before and after, and `estimatedDocumentCount` reads cached metadata that can be stale right after a delete.

This route doubles as the **warmup endpoint**, and that is worth stating because it protects every latency budget in this phase. The first request to a cold Next process pays TLS plus Atlas topology discovery, several hundred milliseconds that will blow a 300 ms budget on the very first tool call of the demo. `embeddings().info()` additionally forces the embedding module to load. The budgets above are measured on a warm process; PHASE-15's preflight must hit `/api/counters` and one `recall_memory` before the pitch.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds
- [ ] Every route from `contracts.md` §10 exists at exactly its documented path and every handler exports `runtime = "nodejs"`
- [ ] Both dynamic handlers `await` their `params` — a search for `params.tool` or `params.incidentId` without `await` returns nothing
- [ ] **Verifiable with all other ports faked:** with `RETRIEVAL_MODE=fake GRAPH_MODE=fake EVENTS_MODE=fake LLM_MODE=fake EMBEDDINGS_MODE=fake`, all seven `/api/tools/*` routes return `200` with a body matching the response shape in the table
- [ ] Every `/api/tools/*` route returns `401` with `{ error: ... }` when `X-BlackBox-Secret` is absent, and `401` when it is present but wrong
- [ ] With `TOOL_SHARED_SECRET` unset, a correctly formed tool request returns `500`, not `200`
- [ ] A body missing a required field returns `400` with `{ error: string }` and performs no write
- [ ] `POST /api/tools/nonexistent_tool` with a valid secret returns `404`
- [ ] Every tool response is logged as `[tool] <name> <ms>ms budget=<n>ms`, and `recall_memory`, `get_protocol`, `propose_readback`, and `log_timeline` are each under their budget on a warm process
- [ ] `composeReadback({ drug: "amiodarone", dose: "300 mg", route: "IV push" })` returns exactly `Confirm: 300 mg of amiodarone, IV push. Say confirm.`
- [ ] `propose_readback` makes **zero** LLM calls — verified with `LLM_MODE=fake` and a counter or log on the fake, or by inspection that no `llm()` reference exists in that handler
- [ ] `record_decision` responds in under 300 ms even when the fake LLM is given an artificial 2-second delay, proving the write is genuinely off the response path
- [ ] An utterance containing a stated reason produces exactly one new `decisions` document with a non-empty `rationale`, both `embedding` and `embeddedText` set, and one `decision` event *(needs Atlas)*
- [ ] An utterance with no stated reason (use the no-reason cases in `fixtures/utterances.json`) produces **zero** new `decisions` documents, logs `RATIONALE MISSING`, and still appends the utterance to `incidents.timeline` *(needs Atlas)*
- [ ] No `spoken` string in any tool response exceeds 40 words, checked on every hit in the response, not just the first
- [ ] `recall_memory` against an empty corpus returns `hits: []` and a spoken string stating there is no prior record, and never a fabricated incident reference
- [ ] `get_protocol`'s `spoken` starts with the `sectionTitle`
- [ ] `confirm_readback` returns a `resumedAt` that is either `null` or a member of `GRAPH_NODE_ORDER`, and emits both a `readback` and a `checkpoint` event
- [ ] `POST /api/demo/fire` returns `{ incidentId, ref, displayId }`; the created document has `isLive: true`, `status: "dispatched"`, `cad.incidentDatetime` within 5 seconds of now, and **no `_groundTruth` field** *(needs Atlas)*
- [ ] `ref` matches `/^\d{6}-\d{4}$/` and `displayId` matches `/^\d{4}$/`
- [ ] `POST /api/demo/fire` with a pattern that matches nothing returns `404` with a message naming `npm run ingest:incidents`
- [ ] **`POST /api/demo/reset` leaves the seed corpus byte-intact:** counts of `runbooks`, `postmortems` with `origin: "seeded"` or `"curated"`, `remediations` with the same, and `incidents` with `isLive: false` are identical before and after; `_embed_cache` and `_watch_state` counts are also unchanged
- [ ] `POST /api/demo/reset` returns non-zero counts for `decisions`, `events`, and live `incidents` when they exist, and returns `200` with all-zero counts on an already-clean database
- [ ] `GET /api/state/[incidentId]` returns `{ values, next, checkpointCount }` for a known incident and `404` for an unknown one
- [ ] `GET /api/counters` returns all six collection counts plus `checkpointCount` and an `embedding` object with `provider`, `model`, and `dim`
- [ ] No response body anywhere in this phase contains a stack trace
- [ ] No file was created or modified outside `app/api/tools/**`, `app/api/demo/**`, `app/api/state/**`, `app/api/counters/**`

## Verification

PowerShell note: set env vars with `$env:VAR="value"` on a preceding line; the inline `VAR=value cmd` form is bash-only.

```bash
npm run typecheck
npm run build
```

Start the app fully faked, so nothing here can accidentally depend on another phase:

```bash
TOOL_SHARED_SECRET=devsecret RETRIEVAL_MODE=fake GRAPH_MODE=fake EVENTS_MODE=fake \
  LLM_MODE=fake EMBEDDINGS_MODE=fake npm run dev
```

Auth, first:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/tools/recall_memory \
  -H 'content-type: application/json' -d '{"incidentId":"x","query":"chest pain"}'          # 401

curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/tools/recall_memory \
  -H 'content-type: application/json' -H 'X-BlackBox-Secret: wrong' \
  -d '{"incidentId":"x","query":"chest pain"}'                                              # 401

curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/tools/recall_memory \
  -H 'content-type: application/json' -H 'X-BlackBox-Secret: devsecret' -d '{"incidentId":"x"}'  # 400

curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/tools/not_a_tool \
  -H 'content-type: application/json' -H 'X-BlackBox-Secret: devsecret' -d '{}'             # 404
```

Fire an incident, then walk the whole tool sequence against it:

```bash
S='X-BlackBox-Secret: devsecret'
J='content-type: application/json'

FIRE=$(curl -s -X POST localhost:3000/api/demo/fire -H "$J" -d '{"pattern":"arrest"}')
echo "$FIRE"
ID=$(echo "$FIRE" | npx tsx -e "process.stdin.on('data',d=>console.log(JSON.parse(d).incidentId))")

curl -s -X POST localhost:3000/api/tools/recall_memory  -H "$J" -H "$S" -d "{\"incidentId\":\"$ID\",\"query\":\"unconscious male, agonal breathing\"}"
curl -s -X POST localhost:3000/api/tools/get_protocol   -H "$J" -H "$S" -d "{\"incidentId\":\"$ID\",\"topic\":\"adult cardiac arrest\"}"
curl -s -X POST localhost:3000/api/tools/log_timeline    -H "$J" -H "$S" -d "{\"incidentId\":\"$ID\",\"text\":\"starting compressions\",\"source\":\"medic\"}"
curl -s -X POST localhost:3000/api/tools/propose_readback -H "$J" -H "$S" -d "{\"incidentId\":\"$ID\",\"utterance\":\"pushing 300 of amio\",\"drug\":\"amiodarone\",\"dose\":\"300 mg\",\"route\":\"IV push\"}"
curl -s -X POST localhost:3000/api/tools/confirm_readback -H "$J" -H "$S" -d "{\"incidentId\":\"$ID\",\"confirmed\":true,\"verbatimOk\":true}"
curl -s -X POST localhost:3000/api/tools/record_decision  -H "$J" -H "$S" -d "{\"incidentId\":\"$ID\",\"utterance\":\"holding off on the supraglottic, family says recent neck surgery\"}"
curl -s -X POST localhost:3000/api/tools/close_call       -H "$J" -H "$S" -d "{\"incidentId\":\"$ID\"}"
```

The `propose_readback` response must be exactly `{"readbackText":"Confirm: 300 mg of amiodarone, IV push. Say confirm."}`.

Latency on a warm process — run each twice and read the second number from the server log:

```bash
for t in recall_memory get_protocol log_timeline propose_readback; do
  curl -s -o /dev/null -w "$t %{time_total}s\n" -X POST localhost:3000/api/tools/$t \
    -H "$J" -H "$S" -d "{\"incidentId\":\"$ID\",\"query\":\"chest pain\",\"topic\":\"chest pain\",\"text\":\"x\",\"source\":\"medic\",\"utterance\":\"x\"}"
done
```

The reset safety check — the single most expensive thing to get wrong in this phase:

```bash
npx tsx -e "
import { col } from './src/lib/db/client';
import { RUNBOOKS, POSTMORTEMS, REMEDIATIONS, INCIDENTS, EMBED_CACHE, WATCH_STATE } from './src/lib/contracts';
const snap = async () => ({
  runbooks: await col(RUNBOOKS).countDocuments({}),
  seededPm: await col(POSTMORTEMS).countDocuments({ origin: { \$in: ['seeded','curated'] } }),
  seededRem: await col(REMEDIATIONS).countDocuments({ origin: { \$in: ['seeded','curated'] } }),
  histInc: await col(INCIDENTS).countDocuments({ isLive: false }),
  cache: await col(EMBED_CACHE).countDocuments({}),
  watch: await col(WATCH_STATE).countDocuments({}),
});
const before = await snap();
const res = await fetch('http://localhost:3000/api/demo/reset', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' });
console.log('deleted', await res.json());
const after = await snap();
console.log('before', before); console.log('after ', after);
console.log('SEED INTACT:', JSON.stringify(before) === JSON.stringify(after));
process.exit(0);
"
```

`SEED INTACT: true` is the criterion. Anything else means the filters are wrong and the corpus has to be re-embedded.

```bash
curl -s localhost:3000/api/counters
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/state/does-not-exist   # 404
```

## Handoff Note

Two things other phases depend on. PHASE-13: every tool call is logged as `[tool] <name> <ms>ms budget=<n>ms`, which is how you prove the agent actually invoked tools; and `composeReadback`'s output string is pinned by an identical assertion in both specs, so do not change the format on one side. PHASE-14: `/api/counters` is the bootstrap for the write counters and the checkpoint counter, and `/api/state/[incidentId]` is the fallback when the SSE stream drops.
