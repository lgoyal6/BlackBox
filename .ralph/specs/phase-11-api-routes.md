# Phase 11 — Tool, Demo, and State API Routes

**Status:** PENDING
**Tasks:** US-021, US-022
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 40 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Ship the HTTP surface that ElevenLabs server tools and the operator console call: seven voice tool routes with shared-secret auth and the contracted latency budgets, plus the demo fire/close/reset controls, a graph state reader, and live collection counters. When this phase is done, a `curl` with `X-BlackBox-Secret` can drive a full call through the fake graph with no voice session and no other phase's modules imported.

## Why These Routes Are The Seam

The agent's tools are **server tools hitting our own Next.js route handlers**. Browser WebRTC and an optional Twilio outbound call run identical logic because both land here. That is why this phase owns the routes and not the voice SDK, and why every handler must be short, authenticated, and honest about what it can do with other ports faked.

Two latency rules from `contracts.md` §10 are judged criteria, not style preferences:

1. `propose_readback` is **deterministic string formatting**. The agent must speak the dose on this turn. An LLM can paraphrase "1 milligram" into "one mg", which is a clinical error and a failed demo beat.
2. `record_decision` **acknowledges immediately** and does extraction plus the embedded write in the background. The medic cannot wait on an embedding round trip before the next sentence.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §10 — every route, request, response, status code, and latency budget. Implement these literally. Do not invent a route, a field, or a status code.
- `.ralph/contracts.md` §9 — `RetrievalPort`, `GraphPort`, `EventsPort`, `LlmPort`, `EmbeddingsPort`. Resolve them through `@/lib/registry`. Never import `@/lib/retrieval`, `@/lib/graph`, `@/lib/events`, `@/lib/memory/*`, or `@/lib/voice/*`.
- `.ralph/contracts.md` §5 — `IncidentDoc`, `PUBLIC_INCIDENT_PROJECTION`, `DecisionDoc`. Agent-facing incident reads must use the projection.
- `.ralph/contracts.md` §6 — `Hit`, `SPOKEN_WORD_CAP` (40). Every snippet returned to the voice agent is capped.
- `.ralph/contracts.md` §7 — `PendingReadback`, `ReadbackConfirmation`, `InterruptPayload`. `confirm_readback` resumes with a `ReadbackConfirmation`.
- `.ralph/contracts.md` §13 — Zod v4 (`z.output<typeof Schema>`), `{ error: string }` errors, `runtime = "nodejs"`, Dates are `Date`.
- `.ralph/contracts.md` §14 — demo corpus floors. Reset must leave them untouched.
- `.ralph/overview.md` — Critical Rules 3, 4, 5, 6, 9; Next.js 16 async `params`; file ownership table.
- `src/lib/contracts/api.ts` (PHASE-01) — the Zod schemas this phase validates against. Do not redefine them.
- `fixtures/incidents.json` — offline source for `POST /api/demo/fire` when Atlas has no historical rows yet.
- `fixtures/utterances.json` — eight medic utterances. Use them to prove `propose_readback` is verbatim and `record_decision` acks before the write lands.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `app/api/tools/[tool]/route.ts` | Single dispatcher for the seven tools |
| `app/api/tools/_lib/auth.ts` | Shared-secret check |
| `app/api/tools/_lib/readback.ts` | Deterministic `composeReadback` used by the tool route |
| `app/api/tools/_lib/handlers.ts` | One function per tool |
| `app/api/tools/_lib/decision-write.ts` | Background extract + embed + insert for `record_decision` |
| `app/api/demo/fire/route.ts` | Clone a historical incident into a live one |
| `app/api/demo/close/route.ts` | Request close on a live incident |
| `app/api/demo/reset/route.ts` | Narrow delete; seeded corpus must survive |
| `app/api/demo/_lib/clone.ts` | Incident clone helper |
| `app/api/state/[incidentId]/route.ts` | Graph state reader |
| `app/api/counters/route.ts` | Collection counts + embedding info |

Create nothing outside `app/api/tools/**`, `app/api/demo/**`, `app/api/state/**`, and `app/api/counters/**`. Do not edit `package.json`. Do not create indexes. Do not add a script.

`src/lib/memory/decisions.ts`, `src/lib/memory/postmortem.ts`, and `src/lib/voice/readback.ts` belong to other phases. **Do not import them.** This phase implements the thin write and the readback formatter in its own `_lib` files so it can pass with those modules absent. Duplication of a ten-line formatter is cheaper than a cross-phase import that breaks parallelism.

### Ports consumed

| Port | Used for | Set this to build in isolation |
|---|---|---|
| `RetrievalPort` | `recall_memory`, `get_protocol` | `RETRIEVAL_MODE=fake` |
| `GraphPort` | `confirm_readback`, `fire` start, `state` | `GRAPH_MODE=fake` |
| `EventsPort` | timeline / decision / write / status emits | `EVENTS_MODE=fake` |
| `LlmPort` | background rationale extract; `close_call` draft | `LLM_MODE=fake` |
| `EmbeddingsPort` | background decision embed | `EMBEDDINGS_MODE=fake` |

`VoicePort` is not consumed. Build and verify with:

```
GRAPH_MODE=fake RETRIEVAL_MODE=fake EVENTS_MODE=fake LLM_MODE=fake EMBEDDINGS_MODE=fake VOICE_MODE=fake
```

The fake graph walks `GRAPH_NODE_ORDER` and raises a `readback` interrupt on the first pass, so `confirm_readback` and `GET /api/state/[incidentId]` are fully testable. The fake retrieval returns `fixtures/hits.json` filtered by substring. The fake LLM returns templated strings. None of that requires PHASE-07, PHASE-08, PHASE-09, or PHASE-13 to exist.

This phase talks to Atlas through `col()` for incident clones, counters, and the background decision insert. If the cluster is empty, `fire` falls back to `fixtures/incidents.json`. That is a supported path, not a failure.

### Ports implemented

None. Nothing here is default-exported or resolved through the registry.

## Files to Create

### `app/api/tools/_lib/auth.ts`

```ts
export function requireSecret(req: Request): Response | null;
```

Compare `req.headers.get("x-blackbox-secret")` to `env.toolSharedSecret` with a length-safe equality check. Missing, empty, or wrong values return a `401` `Response` whose body is `{ error: "unauthorized" }`. Return `null` when the header matches so the caller proceeds.

Check the secret **before** reading the body. A 401 must not depend on a valid JSON payload.

### `app/api/tools/_lib/readback.ts`

```ts
export function composeReadback(fields: {
  utterance: string;
  drug?: string;
  dose?: string;
  route?: string;
}): string;
```

Pure function. **No `llm()` call, no `fetch`, no randomness.** Concatenate the provided fields in a fixed template:

```
Confirming {dose} of {drug}, {route}. Say confirm or correct me.
```

Omit any clause whose field is missing. If only `utterance` is present, return `Confirming: ${utterance.trim()}. Say confirm or correct me.`

**Copy the dose and units character-for-character.** `"1 milligram"` stays `"1 milligram"`. Do not convert to `mg`, do not spell out a digit that arrived as a digit, do not round. This is the aviation-style readback and the LangGraph human-in-the-loop gate. A paraphrase here is a failed acceptance criterion.

This copy exists because PHASE-13 also owns a `composeReadback`. Keep the template identical so a judge cannot hear two different readbacks for the same utterance. If you change the wording, that is a contract change: stop, edit `contracts.md`, log it in `agents.md`.

### `app/api/tools/_lib/decision-write.ts`

```ts
export interface ExtractedDecision {
  actionChosen: string;
  rationale: string | null;
  optionsConsidered: string[];
}

export async function extractDecision(utterance: string): Promise<ExtractedDecision>;
export async function writeDecisionInBackground(input: {
  incidentId: string;
  utterance: string;
}): Promise<void>;
```

`extractDecision` calls `(await llm()).json(...)` with a schema that requires `actionChosen` and allows `rationale` to be `null`. **If the model returns a rationale that is not a substring of the utterance (case-insensitive, ignoring surrounding whitespace), discard it and store `null`.** Never invent a reason. A fabricated rationale in a permanent clinical record is worse than no rationale — it is the harm this project claims to prevent.

`writeDecisionInBackground` is what `record_decision` fires *after* the response is sent:

1. Load the incident with `PUBLIC_INCIDENT_PROJECTION`. If missing, log `DECISION WRITE FAILED` and return.
2. Extract. If `rationale` is `null` or whitespace, **do not insert**. Log `DECISION WRITE SKIPPED: empty rationale` and emit nothing. Critical Rule 4: a decision document without a rationale is a bug, and the server-side validator will reject it anyway.
3. Embed `utterance + actionChosen + rationale` via `(await embeddings()).embedOne(text, "document")`.
4. Insert one `DecisionDoc` into `col(DECISIONS)` with `outcome: "pending"`, `protocolConflict: false`, `t: new Date()`, and both `embedding` and `embeddedText`.
5. Emit a `decision` event and a `write` event through `EventsPort`. `emit` never throws (PHASE-10 contract); still do not wrap it in a way that can fail the voice turn — this function already runs after the response.

Do not import PHASE-09's `recordDecision`. This local writer is how the route stays parallel-safe. PHASE-16's smoke hits this route, not the PHASE-09 module.

### `app/api/tools/_lib/handlers.ts`

```ts
import type { Hit } from "@/lib/contracts";

export type ToolName =
  | "recall_memory"
  | "get_protocol"
  | "log_timeline"
  | "propose_readback"
  | "confirm_readback"
  | "record_decision"
  | "close_call";

export const TOOL_NAMES: readonly ToolName[];

export async function handleTool(
  tool: string,
  body: unknown,
): Promise<{ status: number; json: unknown }>;
```

Unknown `tool` values return `{ status: 404, json: { error: "unknown tool" } }`. Valid tools parse `body` with the matching Zod schema from `@/lib/contracts`. Zod failure returns `{ status: 400, json: { error: <flattened message> } }`. Do not copy Zod v3 error shapes; use the v4 issue API on the installed `zod@4.4.3`.

| `tool` | Port / write | Response | Budget |
|---|---|---|---|
| `recall_memory` | `retrieval().fanOut(query, { callTypeFamily })` | `{ summary, spoken, hits }` | 400 ms warm |
| `get_protocol` | `retrieval().fanOut(topic)` then first `source === "runbooks"` hit | `{ spoken, text, sectionTitle, pageStart }` | 400 ms warm |
| `log_timeline` | `$push` a `TimelineEntry` on the incident; emit `voice` if source is medic/agent | `{ ok: true }` | 150 ms |
| `propose_readback` | `composeReadback` only | `{ readbackText }` | 300 ms, **no LLM** |
| `confirm_readback` | `graph().resume(incidentId, { confirmed, verbatimOk })` | `{ ok, resumedAt }` | 500 ms |
| `record_decision` | ack, then `queueMicrotask` / `setImmediate` the background write | `{ ok: true, ack }` | 300 ms to ack |
| `close_call` | `graph().resume` with close, or a local postmortem draft via `llm().text` if the graph returns nothing | `{ postmortemId, pcrPreview }` | 8 s |

Details that are easy to get wrong:

- **`recall_memory`.** `summary` is one sentence, ≤ 25 words, built from the top hit's `spoken` or the literal `new signature, no prior history` when `hits` is empty. Cap every `hits[i].spoken` at `SPOKEN_WORD_CAP` before returning. Emit a `retrieval` event. Never read `_groundTruth`.
- **`get_protocol`.** If no runbook hit exists, return `{ spoken: "No matching protocol section.", text: "", sectionTitle: "", pageStart: 0 }` with status 200, not 404. A missing guideline is a normal retrieval miss, not a missing route. Attribute in `spoken`: prefix `From NASEMSO, ` so the agent has attribution to read aloud.
- **`log_timeline`.** `$push` `{ t: new Date(), source, text }`. Reject `source` values outside `"medic" | "agent" | "system"` via the Zod schema, not a runtime check after the write.
- **`propose_readback`.** Call `composeReadback` and return. Grep the handler file for `llm` and `embeddings` — both must be absent. Optionally emit a `readback` event with `state: "awaiting"`.
- **`confirm_readback`.** `resumedAt` is `result.interrupt === null ? "execute_record" : result.interrupt.type === "readback" ? "readback_gate" : null` mapped onto `GraphNode | null`. Emit `readback` with `state: "confirmed" | "rejected"`.
- **`record_decision`.** `ack` is the fixed string `Recorded.` Return before the insert. The document must appear in `decisions` within 3 seconds when rationale is extractable.
- **`close_call`.** Set `closeRequested` by resuming the graph with `{ close: true }` if that is what the fake accepts; otherwise write a live postmortem via `llm().text` capped at 200 words, embed it, insert with `origin: "live"`, and emit `pcr` + `write`. Never read `_groundTruth` to fill `whatChanged`.

### `app/api/tools/[tool]/route.ts`

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ tool: string }> },
): Promise<Response>;
```

**Next.js 16: `params` is a `Promise`.** `const { tool } = await params;` A copied Next 14/15 signature will not compile under `strict`.

Order: `requireSecret` → `await params` → `await req.json()` (empty body becomes `{}`) → `handleTool` → `Response.json(json, { status })`. Catch thrown errors and return `500` `{ error: "internal" }` without leaking stack traces.

### `app/api/demo/_lib/clone.ts`

```ts
export type FirePattern = "arrest" | "cardiac";

export async function cloneLiveIncident(
  pattern: FirePattern,
  incidentId?: string,
): Promise<{ incidentId: string; ref: string; displayId: string }>;
```

Clone a **real ingested historical row** (or a fixture row) into a new `isLive: true` document:

| `pattern` | Source filter |
|---|---|
| `arrest` | `cad.initialCallType === "UNC"` and `_groundTruth.finalCallType === "ARREST"` |
| `cardiac` | `cad.initialCallType === "SICK"` and `_groundTruth.finalCallType === "CARD"` |

Prefer Atlas `incidents` with `isLive: false`. If none match, read `fixtures/incidents.json`. If `incidentId` is provided, clone that row instead of picking, but still require it to match the pattern; otherwise 400.

The live document:

- New `incidentId`: `live-${Date.now()}` (or the caller-supplied id if unused).
- Recompute `displayId` and `ref` via `toDisplayId` / `toRef`.
- `status: "dispatched"`, `timeline: []`, `isLive: true`, `createdAt`/`updatedAt` now.
- **Do not copy `_groundTruth` onto the live document.** Critical Rule 6: answers stay quarantined on the historical seed. A live clone that carries the final call type will leak it into any careless `findOne`.

Then `graph().start(newId)` and emit a `status` event. If `start` throws because the fake or the real graph is unhappy, still return the ids — the worker (PHASE-12) is the production trigger, and this route must not fail a rehearsal because the graph phase is mid-flight. Log `GRAPH START FAILED` in that case.

### `app/api/demo/fire/route.ts`

```ts
export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response>;
```

Validate with the contract Zod schema (`{ pattern: "arrest" | "cardiac", incidentId?: string }`). Return `{ incidentId, ref, displayId }`.

### `app/api/demo/close/route.ts`

```ts
export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response>;
```

`{ incidentId }` → set `status: "closed"` on that live incident, emit `status`, return `{ ok: true }`. 404 if the incident does not exist.

### `app/api/demo/reset/route.ts`

```ts
export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response>;
```

Deletes **only** the live residue of a rehearsal. The filter list is closed:

| Collection | Delete filter |
|---|---|
| `decisions` | `{}` — the collection is live-only (Critical Rule 5) |
| `postmortems` | `{ origin: "live" }` |
| `remediations` | `{ origin: "live" }` |
| `events` | `{}` |
| `checkpoints` | `{}` |
| `checkpoint_writes` | `{}` |
| `incidents` | `{ isLive: true }` |

Return `{ deleted: Record<string, number> }` with one key per collection above, using `deletedCount`.

**Must never match:** `runbooks`, `postmortems` with `origin: "seeded"` or `"curated"`, `remediations` with `origin: "seeded"` or `"curated"`, historical `incidents` (`isLive: false`), `_embed_cache`, `_watch_state`. Re-embedding the seed corpus twenty minutes before the pitch is a self-inflicted wound. PHASE-16 and PHASE-15 both assert the seeded floors survive this route.

Count seeded postmortems, runbooks, and historical incidents **before and after**. If any of those three counts drop, throw and return 500 — do not swallow a bad filter.

Do not `deleteMany({})` on `_watch_state`. PHASE-10 stores `seq:*` counters there and PHASE-12 stores `watch:*` / `poll:*` resume tokens. Resetting them looks convenient and breaks both streams.

### `app/api/state/[incidentId]/route.ts`

```ts
export const runtime = "nodejs";
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ incidentId: string }> },
): Promise<Response>;
```

`await params`, then `graph().state(incidentId)`. Return `{ values, next, checkpointCount }`. Empty `incidentId` is 400. Unknown thread returns whatever the fake/real graph returns; do not 404 on an empty state — a dashboard may poll before `start`.

### `app/api/counters/route.ts`

```ts
export const runtime = "nodejs";
export async function GET(): Promise<Response>;
```

```ts
{
  counts: Record<string, number>;      // incidents, decisions, remediations, runbooks, postmortems, events, checkpoints
  checkpointCount: number;             // same as counts.checkpoints
  embedding: { provider: string; model: string; dim: number };
}
```

`embedding` comes from `(await embeddings()).info()`. Under `EMBEDDINGS_MODE=fake` that is the fake's info, which is correct and expected.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds
- [ ] All seven tools exist at `POST /api/tools/[tool]` and reject a missing or wrong `X-BlackBox-Secret` with `401` `{ error: "unauthorized" }`
- [ ] An invalid JSON body returns `400` `{ error: string }`
- [ ] An unknown tool name returns `404` `{ error: string }`
- [ ] `params` is awaited in both `[tool]` and `[incidentId]` routes — `rg -n "params: Promise" app/api` finds both, and `rg -n "params.tool|params.incidentId" app/api` finds nothing that is not after an `await`
- [ ] Every handler file exports `runtime = "nodejs"`
- [ ] `propose_readback` with `{ utterance, drug: "epinephrine", dose: "1 milligram", route: "IV" }` returns a `readbackText` containing the substrings `1 milligram`, `epinephrine`, and `IV`, and finishes in under 300 ms
- [ ] `rg -n "llm|embeddings|openai" app/api/tools/_lib/readback.ts app/api/tools/_lib/handlers.ts` does not match `propose_readback`'s code path (no LLM import in `readback.ts`; `handlers.ts` must not call `llm()` inside the `propose_readback` branch)
- [ ] `record_decision` returns `{ ok: true, ack: string }` in under 300 ms, and when the utterance contains a reason, a `decisions` document with a non-empty `rationale` appears within 3 seconds
- [ ] `record_decision` with an utterance that has no reason inserts **zero** documents
- [ ] `recall_memory` and `get_protocol` return in under 400 ms warm against fake retrieval, and every `spoken` field is 40 words or fewer
- [ ] `confirm_readback` with `{ confirmed: true, verbatimOk: true }` returns `ok: true` and a subsequent `GET /api/state/[incidentId]` no longer sits at `readback_gate` when the fake graph is used
- [ ] `POST /api/demo/fire` with `{ pattern: "arrest" }` returns `{ incidentId, ref, displayId }` and inserts one `isLive: true` incident whose `cad.initialCallType` is `UNC` and which has **no** `_groundTruth` field
- [ ] `POST /api/demo/fire` with `{ pattern: "cardiac" }` clones a `SICK` incident the same way
- [ ] `POST /api/demo/reset` deletes all `decisions`, live postmortems, live remediations, all events, all checkpoints, and `isLive: true` incidents
- [ ] **Seeded corpus survives reset:** `postmortems` with `origin: "seeded"` ≥ 30 (or unchanged if the cluster is below the floor), `runbooks` ≥ 30 (or unchanged), historical `incidents` (`isLive: false`) unchanged. Assert counts before and after. Do not use the old warehouse numbers (2000 / 300).
- [ ] `GET /api/state/[incidentId]` returns `{ values, next, checkpointCount }`
- [ ] `GET /api/counters` returns `counts`, `checkpointCount`, and `embedding`
- [ ] **Verifiable with all other ports faked:** the fire → propose_readback → confirm_readback → record_decision → close → reset path succeeds with `GRAPH_MODE=fake RETRIEVAL_MODE=fake EVENTS_MODE=fake LLM_MODE=fake EMBEDDINGS_MODE=fake VOICE_MODE=fake`
- [ ] No file was created or modified outside this phase's four `app/api/*` trees
- [ ] `rg -n "_groundTruth" app/api` returns no read of that field except the historical-source filter inside `clone.ts`

## Verification

PowerShell note: set env vars with `$env:VAR="value"` on a preceding line; the inline `VAR=value cmd` form below is bash-only.

```bash
npm run typecheck
npm run build

# All other ports faked. Dev server in one terminal:
GRAPH_MODE=fake RETRIEVAL_MODE=fake EVENTS_MODE=fake \
  LLM_MODE=fake EMBEDDINGS_MODE=fake VOICE_MODE=fake npm run dev
```

In a second terminal, with `SECRET` set to `TOOL_SHARED_SECRET`:

```bash
# 401 without the header
curl -s -o /tmp/bb.json -w "%{http_code}" -X POST http://localhost:3000/api/tools/recall_memory \
  -H "content-type: application/json" -d '{"incidentId":"x","query":"unc"}'
# expect 401

# Fire arrest, then cardiac
curl -s -X POST http://localhost:3000/api/demo/fire \
  -H "content-type: application/json" -d '{"pattern":"arrest"}'
curl -s -X POST http://localhost:3000/api/demo/fire \
  -H "content-type: application/json" -d '{"pattern":"cardiac"}'

# Readback must be verbatim and fast
time curl -s -X POST http://localhost:3000/api/tools/propose_readback \
  -H "content-type: application/json" -H "X-BlackBox-Secret: $SECRET" \
  -d '{"incidentId":"ID","utterance":"pushing one milligram of epi, IV","drug":"epinephrine","dose":"1 milligram","route":"IV"}'
# expect readbackText contains "1 milligram" and "epinephrine"; wall time < 0.3s

# Decision ack-then-write
time curl -s -X POST http://localhost:3000/api/tools/record_decision \
  -H "content-type: application/json" -H "X-BlackBox-Secret: $SECRET" \
  -d '{"incidentId":"ID","utterance":"skipping the supraglottic, family reports recent neck surgery"}'
# expect { ok: true } in < 0.3s; then within 3s:
# decisions.countDocuments({ incidentId: "ID" }) === 1 and rationale nonempty

# Reset must not eat the seed
# record seeded postmortem / runbook / historical incident counts, POST /api/demo/reset, re-count
curl -s -X POST http://localhost:3000/api/demo/reset -H "content-type: application/json" -d '{}'
curl -s http://localhost:3000/api/counters
```

```bash
rg -n "params: Promise" app/api
rg -n "_groundTruth" app/api
rg -n "llm|embeddings" app/api/tools/_lib/readback.ts
```

## Handoff Note

PHASE-13: tool URLs are `POST ${PUBLIC_BASE_URL}/api/tools/<name>` with header `X-BlackBox-Secret`. `propose_readback` is the verbatim gate; do not replace it with an LLM in the agent prompt. PHASE-12: `fire` inserts `isLive: true` and may or may not have called `graph().start` — the worker is the production trigger. PHASE-16: smoke drives this exact path; if reset wipes runbooks, the bug is the delete filter in this phase.
