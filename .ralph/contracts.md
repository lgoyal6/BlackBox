# BlackBox — Shared Contracts

> **The single source of truth for everything that crosses a phase boundary.** PHASE-01 turns this file into `src/lib/contracts/`. Every other phase codes against it and never redefines any of it.
>
> **Changing anything here is a contract change.** Stop, edit this file, log it in `agents.md` under Technical Decisions, then implement. Fourteen agents are reading this concurrently; a silent change breaks them all.

## 1. Module layout (import paths are part of the contract)

```
src/lib/contracts/
  index.ts        # re-exports everything below
  collections.ts  # collection names, index names
  domain.ts       # document types, enums, CODE_LABELS, families
  events.ts       # event discriminated union
  api.ts          # request/response types + zod schemas for every route
  ids.ts          # id/ref/displayId helpers
src/lib/ports.ts        # port interfaces only, no implementations
src/lib/registry.ts     # resolves real vs fake per env; NO phase edits this
src/lib/fakes/          # deterministic fakes for every port
src/lib/db/client.ts    # getClient / getDb / col
src/lib/llm.ts          # LlmPort real implementation (thin, owned by PHASE-01)
fixtures/               # deterministic test data
```

Path alias: `@/*` → `src/*`. Import as `import { INCIDENTS } from "@/lib/contracts"`.

**Every phase imports only from `@/lib/contracts`, `@/lib/ports`, `@/lib/registry`, `@/lib/db/client`, and its own files.** Never import another phase's module directly.

## 2. Collections and index names

```ts
export const INCIDENTS = "incidents";
export const DECISIONS = "decisions";
export const REMEDIATIONS = "remediations";
export const RUNBOOKS = "runbooks";
export const POSTMORTEMS = "postmortems";
export const EVENTS = "events";
export const CHECKPOINTS = "checkpoints";
export const CHECKPOINT_WRITES = "checkpoint_writes";
export const EMBED_CACHE = "_embed_cache";
export const WATCH_STATE = "_watch_state";

export const VECTOR_COLLECTIONS = [DECISIONS, REMEDIATIONS, RUNBOOKS, POSTMORTEMS] as const;
/** The three-source fan-out pipeline. Order matters: index 0 is the base collection. */
export const FAN_OUT_COLLECTIONS = [DECISIONS, POSTMORTEMS, RUNBOOKS] as const;

export const vectorIndexName = (coll: string) => `vs_${coll}`;   // vs_decisions, ...
export const VECTOR_PATH = "embedding";
```

## 3. Identifiers

Three distinct id forms. Mixing them up is the most likely cross-phase bug.

| Field | Example | Used for |
|---|---|---|
| `incidentId` | `16975942` (seeded) or `live-1755126000123` | database key, LangGraph `thread_id`, every join |
| `displayId` | `5942` | **spoken aloud** — "this resembles incident 5942" |
| `ref` | `260813-0442` | dashboard header, matches `reference.png` |

```ts
/** Last 4 digits of incidentId, digits-only, left-padded. Collisions disambiguated by caller. */
export function toDisplayId(incidentId: string): string;
/** `${yy}${mm}${dd}-${displayId}` from the incident datetime. */
export function toRef(incidentId: string, at: Date): string;
```

**Never speak an 8-digit `incidentId`.** A TTS voice reading "one six nine seven five nine four two" is unusable in the field and sounds terrible on stage. Voice always uses `displayId`.

## 4. Domain enums and constants

```ts
export type IncidentStatus = "dispatched" | "en_route" | "on_scene" | "transporting" | "closed";
export type CallTypeFamily =
  | "cardiac" | "respiratory" | "altered" | "trauma" | "behavioral" | "general" | "other";
export type DecisionOutcome = "pending" | "worked" | "failed" | "unknown";
export type RemediationOutcome = "success" | "failure";
export type MemoryOrigin = "seeded" | "curated" | "live";
export type TimelineSource = "medic" | "agent" | "system";
export type RetrievalSource = "decisions" | "postmortems" | "runbooks";
export type GraphNode =
  | "triage" | "signature_match" | "brief" | "plan" | "readback_gate"
  | "execute_record" | "verify" | "record_decision" | "await_input" | "postmortem";

export const GRAPH_NODE_ORDER: GraphNode[] = [
  "triage", "signature_match", "brief", "plan", "readback_gate",
  "execute_record", "verify", "record_decision", "await_input", "postmortem",
];
```

`CALL_TYPE_FAMILY` maps raw NYC codes to families:

| Family | Codes |
|---|---|
| `cardiac` | `CARD`, `CARDBR`, `ARREST`, `CVAC` |
| `respiratory` | `DIFFBR`, `ASTHMB`, `RESPIR` |
| `altered` | `UNC`, `UNKNOW`, `DRUG`, `EDPC` |
| `trauma` | `INJURY`, `INJMAJ`, `SHOT`, `STAB` |
| `behavioral` | `EDP`, `EDPM` |
| `general` | `SICK`, `OBLABR`, `ABDPN` |
| `other` | anything unmapped |

```ts
export function callTypeFamily(code: string): CallTypeFamily;
```

`CODE_LABELS` — **required because the agent says these out loud.** "UNC" read by a TTS voice is unintelligible.

```ts
export const CODE_LABELS: Record<string, string> = {
  UNC: "unconscious or unresponsive",
  ARREST: "cardiac arrest",
  CARD: "cardiac condition",
  CARDBR: "cardiac condition with breathing difficulty",
  SICK: "general illness",
  DRUG: "drug overdose",
  EDP: "emotionally disturbed person",
  EDPC: "emotionally disturbed person, combative",
  EDPM: "emotionally disturbed person, medical",
  INJURY: "injury",
  INJMAJ: "major injury",
  DIFFBR: "difficulty breathing",
  UNKNOW: "unknown condition",
  CVAC: "possible stroke",
  ASTHMB: "asthma",
  OBLABR: "obstetric labor",
  ABDPN: "abdominal pain",
  SHOT: "gunshot wound",
  STAB: "stab wound",
  RESPIR: "respiratory arrest",
};
/** Falls back to a humanized version of the raw code; never returns the bare code. */
export function labelFor(code: string): string;
```

**Severity codes: lower = more severe (1 most, 8 least). Valid range 1–8; drop 0 and 9 as noise.** Empirically resolved from mean response times — do not re-derive.

## 5. Document types

```ts
export interface TimelineEntry {
  t: Date;
  source: TimelineSource;
  text: string;
  kind?: "narration" | "question" | "readback" | "confirmation" | "system";
}

export interface CadFields {
  initialCallType: string;
  initialSeverityLevelCode: number;   // 1..8
  borough: string;
  zipcode: string;
  dispatchArea: string;               // incident_dispatch_area, e.g. "B3"
  unit?: string;                      // synthesized for the demo, e.g. "14B"
  incidentDatetime: Date;
}

/** QUARANTINED. No graph node, retrieval path, or voice tool may read this. */
export interface GroundTruth {
  finalCallType: string;
  finalSeverityLevelCode: number;
  severityDelta: number;              // initial - final; positive = upgraded = undertriaged
  incidentCloseDatetime: Date | null;
  incidentDispositionCode: string | null;
  reopenIndicator: boolean;
  dispatchResponseSeconds: number | null;
  incidentResponseSeconds: number | null;
  incidentTravelSeconds: number | null;
}

export interface IncidentDoc {
  incidentId: string;
  displayId: string;
  ref: string;
  status: IncidentStatus;
  cad: CadFields;
  callTypeFamily: CallTypeFamily;
  timeline: TimelineEntry[];
  isLive: boolean;                    // true = created for the demo, false = historical seed
  _groundTruth?: GroundTruth;
  createdAt: Date;
  updatedAt: Date;
}

/** Projection every agent-facing read MUST use. */
export const PUBLIC_INCIDENT_PROJECTION = { _groundTruth: 0 } as const;

export interface DecisionDoc {
  incidentId: string;
  displayId: string;
  utterance: string;                  // verbatim medic speech
  actionChosen: string;               // required, non-empty
  rationale: string;                  // required, non-empty — Critical Rule 4
  optionsConsidered: string[];
  outcome: DecisionOutcome;
  protocolConflict: boolean;          // rendered as "no protocol conflict" in the UI
  callTypeFamily: CallTypeFamily;
  embedding: number[];
  embeddedText: string;               // exactly what was embedded, kept for debugging
  t: Date;
}

export interface RemediationDoc {
  incidentId: string;
  action: string;
  outcome: RemediationOutcome;
  durationSeconds: number | null;
  costMinutes: number | null;         // time lost; derived from real fields, never invented
  sideEffects: string[];
  origin: MemoryOrigin;
  callTypeFamily: CallTypeFamily;
  embedding: number[];
  embeddedText: string;
  t: Date;
}

export interface RunbookDoc {
  source: "NASEMSO-2022-v3";
  sectionTitle: string;
  sectionPath: string[];              // ["Cardiovascular", "Adult Cardiac Arrest"]
  text: string;
  pageStart: number;
  pageEnd: number;
  chunkIndex: number;
  embedding: number[];
  embeddedText: string;
}

export interface PostmortemDoc {
  incidentId: string;
  displayId: string;
  narrative: string;                  // 40-200 words, first person plural, past tense
  whatChanged: string;                // "UNC → ARREST"
  severityDelta: number;
  lessons: string[];
  origin: MemoryOrigin;
  callTypeFamily: CallTypeFamily;
  embedding: number[];
  embeddedText: string;
  t: Date;
}
```

## 6. Retrieval types

```ts
export interface Hit {
  source: RetrievalSource;
  docId: string;
  score: number;        // raw vector score from its own collection
  rank: number;         // 1-based rank within its own source
  rrf: number;          // fused score
  title: string;        // sectionTitle | whatChanged | actionChosen
  text: string;         // full snippet, for the dashboard
  spoken: string;       // <= 40 words, for TTS
  displayId: string | null;
  meta: Record<string, unknown>;   // pageStart, origin, incidentId, costMinutes...
}

export interface SignatureMatch {
  hits: Hit[];
  summary: string;      // one spoken sentence, <= 25 words
  displayId: string;    // the incident referenced, for "resembles incident 4471"
  confidence: number;
}

export interface ExcludedPath {
  path: string;
  why: string;
  sourceDisplayId: string;
  costMinutes: number | null;
}

export interface PlanResult {
  steps: { action: string; why: string }[];   // logistics/documentation ONLY, never treatment
  excludedPaths: ExcludedPath[];              // must be non-empty on demo call 2
}

/** Powers the brief line: "this call type in B3 reclassifies to cardiac 18% of the time overnight." */
export interface ReclassPrior {
  initialCallType: string;
  dispatchArea: string | null;
  nightOnly: boolean;
  sampleSize: number;
  top: { finalCallType: string; family: CallTypeFamily; pct: number; n: number }[];
}

export const SIGNATURE_MATCH_FLOOR = 0.62;   // below this, signatureMatch returns null
export const RRF_K = 60;
export const SOURCE_WEIGHTS: Record<RetrievalSource, number> = {
  decisions: 1.3, postmortems: 1.2, runbooks: 1.0,
};
export const SPOKEN_WORD_CAP = 40;
```

## 7. Graph state

```ts
export interface IncidentState {
  incidentId: string;
  displayId: string;
  ref: string;
  status: IncidentStatus;
  cad: CadFields;
  callTypeFamily: CallTypeFamily;
  timeline: TimelineEntry[];            // reducer: concat
  nodeTrail: GraphNode[];               // reducer: concat
  retrieved: Hit[];                     // reducer: concat
  decisionsRecorded: string[];          // reducer: concat
  signature: SignatureMatch | null;
  plan: PlanResult | null;
  brief: string | null;
  pendingReadback: PendingReadback | null;
  lastConfirmation: ReadbackConfirmation | null;
  closeRequested: boolean;
}

export interface PendingReadback {
  utterance: string;
  readbackText: string;                 // exactly what the agent will speak
  fields: { drug?: string; dose?: string; route?: string; [k: string]: string | undefined };
}

export interface ReadbackConfirmation { confirmed: boolean; verbatimOk: boolean }

export type InterruptPayload =
  | ({ type: "readback"; incidentId: string } & PendingReadback)
  | { type: "await_input"; incidentId: string; status: IncidentStatus };
```

`thread_id` **is** `incidentId`. One LangGraph thread per call.

## 8. Events (the dashboard renders exactly these)

Stored in the `events` collection, change-streamed to the browser via SSE.

```ts
export interface EventBase {
  _id?: string;
  seq: number;              // monotonic per incident
  incidentId: string | null;
  t: Date;
}

export type BlackboxEvent = EventBase & (
  | { kind: "status";     payload: { status: IncidentStatus; ref: string; label: string;
                                     dispatchArea: string; unit?: string } }
  | { kind: "node";       payload: { node: GraphNode; phase: "enter" | "exit" } }
  | { kind: "voice";      payload: { speaker: "medic" | "agent"; text: string;
                                     clock: string } }        // clock = "44:31"
  | { kind: "decision";   payload: { decisionId: string; actionChosen: string;
                                     rationaleRecorded: boolean; protocolConflict: boolean } }
  | { kind: "readback";   payload: { state: "awaiting" | "confirmed" | "rejected";
                                     readbackText: string } }
  | { kind: "retrieval";  payload: { query: string; hits: Hit[] } }
  | { kind: "write";      payload: { collection: string; count: number } }
  | { kind: "checkpoint"; payload: { count: number } }
  | { kind: "pcr";        payload: { postmortemId: string; preview: string } }
);
```

`events` has a **TTL index on `t` of 24 hours** so rehearsal runs self-clean.

## 9. Ports

```ts
export interface EmbeddingsPort {
  embed(texts: string[], inputType: "document" | "query"): Promise<number[][]>;
  embedOne(text: string, inputType?: "document" | "query"): Promise<number[]>;
  info(): { provider: string; model: string; dim: number };
}

export interface RetrievalPort {
  fanOut(query: string, opts?: { kPerSource?: number; limit?: number;
                                 callTypeFamily?: CallTypeFamily }): Promise<Hit[]>;
  signatureMatch(incident: IncidentDoc): Promise<SignatureMatch | null>;
  failureMemory(query: string, family?: CallTypeFamily): Promise<Hit[]>;
  reclassPrior(initialCallType: string, dispatchArea?: string): Promise<ReclassPrior | null>;
}

export interface LlmPort {
  json<T>(prompt: string, schema: unknown, opts?: { model?: string }): Promise<T>;
  text(prompt: string, opts?: { model?: string; maxWords?: number }): Promise<string>;
}

export interface EventsPort {
  emit(e: Omit<BlackboxEvent, "seq" | "t" | "_id">): Promise<void>;
  recent(incidentId: string | null, n?: number): Promise<BlackboxEvent[]>;
}

export interface GraphPort {
  start(incidentId: string): Promise<{ interrupt: InterruptPayload | null }>;
  resume(incidentId: string, value: unknown): Promise<{ interrupt: InterruptPayload | null }>;
  state(incidentId: string): Promise<{ values: Partial<IncidentState>; next: string[];
                                       checkpointCount: number }>;
}

export interface VoicePort {
  speak(incidentId: string, text: string): Promise<void>;
  signedUrl(): Promise<{ url: string; agentId: string }>;
}
```

### Registry (PHASE-01 owns; no other phase edits it)

Resolution is by env var and **static import paths**, so adding a real implementation never requires editing the registry:

```ts
export async function embeddings(): Promise<EmbeddingsPort>;   // EMBEDDINGS_MODE
export async function retrieval(): Promise<RetrievalPort>;      // RETRIEVAL_MODE
export async function llm(): Promise<LlmPort>;                  // LLM_MODE
export async function events(): Promise<EventsPort>;            // EVENTS_MODE
export async function graph(): Promise<GraphPort>;              // GRAPH_MODE
export async function voice(): Promise<VoicePort>;              // VOICE_MODE
```

Each resolves `fake` → `@/lib/fakes/<name>`, otherwise the fixed real path (`@/lib/embeddings`, `@/lib/retrieval`, `@/lib/llm`, `@/lib/events`, `@/lib/graph`, `@/lib/voice`). Each real module **must default-export an object satisfying its port** at exactly that path — that is the whole integration contract.

### Fake behaviour (PHASE-01 owns; every phase depends on it)

| Fake | Behaviour |
|---|---|
| `fakes/embeddings` | `sha256(text)` → deterministic unit vector of `EMBEDDING_DIM`. Same text always same vector, different texts near-orthogonal. Zero network. |
| `fakes/retrieval` | Returns hits from `fixtures/hits.json`, filtered by a substring match on the query. `signatureMatch` returns `null` when the query contains `"transfer"`, a match otherwise. |
| `fakes/llm` | Templated deterministic strings. `json()` returns the schema's example. Zero network. |
| `fakes/events` | Appends to a module-level array, exposes `__drain()` for assertions. |
| `fakes/graph` | Walks `GRAPH_NODE_ORDER`, raising a `readback` interrupt at `readback_gate` on the first pass. |
| `fakes/voice` | `console.log` of what it would speak; `signedUrl` returns a dummy. |

## 10. API routes

All under `app/api`. Every handler: `export const runtime = "nodejs"`. **Next.js 16: `params` is a `Promise`** — `const { tool } = await params`.

Errors are always `{ error: string }` with 400 (validation), 401 (bad secret), 404 (not found), 500 (internal).

### `GET /api/events?incidentId=<id>` — SSE (PHASE-10)

`Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. First frame is a replay of the last 200 events, then live from the change stream. Heartbeat comment every 15 s or proxies close it.

### `POST /api/tools/[tool]` (PHASE-11)

Requires header `X-BlackBox-Secret: $TOOL_SHARED_SECRET` → 401 otherwise.

| `tool` | Request | Response | Latency budget |
|---|---|---|---|
| `recall_memory` | `{ incidentId, query }` | `{ summary: string; spoken: string; hits: Hit[] }` | **400 ms** |
| `get_protocol` | `{ incidentId, topic }` | `{ spoken: string; text: string; sectionTitle: string; pageStart: number }` | **400 ms** |
| `log_timeline` | `{ incidentId, text, source }` | `{ ok: true }` | 150 ms |
| `propose_readback` | `{ incidentId, utterance, drug?, dose?, route? }` | `{ readbackText: string }` | **300 ms**, synchronous, no LLM |
| `confirm_readback` | `{ incidentId, confirmed, verbatimOk }` | `{ ok: boolean; resumedAt: GraphNode \| null }` | 500 ms |
| `record_decision` | `{ incidentId, utterance }` | `{ ok: true; ack: string }` | 300 ms, **write happens after the response** |
| `close_call` | `{ incidentId }` | `{ postmortemId: string; pcrPreview: string }` | 8 s |

Latency is a judged criterion. Two consequences baked into the contract: `record_decision` acknowledges immediately and does LLM extraction plus the embedded write in the background; `propose_readback` is deterministic string formatting because the agent must speak it verbatim on this turn and an LLM can paraphrase a dose.

### Demo + state routes (PHASE-11)

| Route | Request | Response |
|---|---|---|
| `POST /api/demo/fire` | `{ pattern: "arrest" \| "cardiac"; incidentId?: string }` | `{ incidentId, ref, displayId }` |
| `POST /api/demo/close` | `{ incidentId }` | `{ ok: true }` |
| `POST /api/demo/reset` | `{}` | `{ deleted: Record<string, number> }` |
| `GET /api/state/[incidentId]` | — | `{ values, next, checkpointCount }` |
| `GET /api/counters` | — | `{ counts: Record<string, number>; checkpointCount: number; embedding: {...} }` |

`POST /api/demo/reset` deletes **only**: all `decisions`, `postmortems` with `origin: "live"`, `remediations` with `origin: "live"`, all `events`, all checkpoints, and `incidents` with `isLive: true`. **It must never touch `runbooks`, seeded postmortems, or seeded remediations** — re-embedding the seed corpus twenty minutes before the pitch is a self-inflicted wound.

### `GET /api/voice/signed-url` (PHASE-13)

`{ url: string; agentId: string }`. Server-side only; the ElevenLabs API key never reaches the browser.

## 11. Fixtures (PHASE-01 owns; other phases read)

| File | Contents | Consumed by |
|---|---|---|
| `fixtures/incidents.json` | 6 incident docs: 2 `UNC`→`ARREST`, 2 `SICK`→`CARD`, 2 control | 02, 04, 07, 08, 09, 11 |
| `fixtures/hits.json` | 12 `Hit` objects across all three sources, with scores | 07, 08, 14 |
| `fixtures/runbook-chunks.json` | 4 `RunbookDoc` without embeddings | 05, 07 |
| `fixtures/postmortems.json` | 6 `PostmortemDoc` without embeddings, incl. the diversion narrative | 06, 07 |
| `fixtures/event-stream.json` | ~40 `BlackboxEvent` reproducing the full `reference.png` state | 10, 14 |
| `fixtures/curated-postmortems.json` | **PHASE-06 owns this one** — the 2–3 curated demo narratives | 06 |
| `fixtures/utterances.json` | 8 medic utterances with expected action/rationale splits | 09, 13 |

`fixtures/event-stream.json` is what lets the dashboard be built to pixel-match `reference.png` with no backend running at all.

## 12. npm scripts (contract — phases add nothing outside their own)

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "typecheck": "tsc --noEmit",
  "lint": "next lint",
  "worker": "tsx worker/index.ts",
  "check": "tsx scripts/check-atlas.ts",
  "indexes": "tsx scripts/create-indexes.ts",
  "ingest:incidents": "tsx scripts/ingest-incidents.ts",
  "ingest:runbooks": "tsx scripts/ingest-runbooks.ts",
  "seed": "tsx scripts/seed-memory.ts",
  "pitch": "tsx scripts/compute-pitch-number.ts",
  "verify:retrieval": "tsx scripts/verify-retrieval.ts",
  "graph:local": "tsx scripts/run-graph-local.ts",
  "drill": "tsx scripts/kill-resume-drill.ts",
  "agent:setup": "tsx scripts/setup-agent.ts",
  "demo:fire": "tsx scripts/demo-fire.ts",
  "preflight": "tsx scripts/demo-preflight.ts",
  "integrate": "tsx scripts/integrate.ts",
  "smoke": "tsx scripts/smoke.ts"
}
```

PHASE-01 creates `package.json` with **all** of these, including scripts whose target files do not exist yet. Adding a script later means editing a file another phase owns.

## 13. Conventions

- **TypeScript strict.** No `any` in exported signatures.
- **Zod v4** for every route body. `z.output<typeof Schema>` is the handler's parameter type.
- **Dates are `Date`.** The Mongo client is constructed so dates round-trip as UTC. Never store an ISO string in a date field.
- **`mongodb` must be in `serverExternalPackages`** in `next.config.ts`, along with `unpdf` for PHASE-05.
- **Every vector write sets both `embedding` and `embeddedText`.** The text is what makes retrieval debuggable at hour seven.
- **`EMBEDDING_DIM` must equal every vector index's `numDimensions`.** A mismatch returns zero results with no error — the single most expensive failure mode in this build. Assert it at both write and index-creation time.
- **Never construct `MemorySaver`.** `MongoDBSaver` only, everywhere.
- **Never read `_groundTruth`** outside seeding scripts and the closing metrics script.
- **Never download the NYC bulk CSV.** Atlas holds the demo slice in §14. City-wide numbers come from Socrata `COUNT` aggregates only.

## 14. Demo corpus (hackathon scale — do not enlarge)

This is a one-day demo, not a warehouse. Every ingest script must use these constants. Raising a limit "to be safe" is how this phase eats an hour.

```ts
export const SOCRATA_BASE = "https://data.cityofnewyork.us/resource/76xm-jjuj.json";
export const SOCRATA_YEAR_FLOOR = "2024-01-01T00:00:00";

/** Row downloads. Four requests, ~180 documents, never paged past these limits. */
export const DEMO_SLICES = [
  { name: "arrest",    where: "initial_call_type='UNC' AND final_call_type='ARREST' AND incident_datetime>'2024-01-01T00:00:00'", limit: 40 },
  { name: "cardiac",   where: "initial_call_type='SICK' AND final_call_type='CARD' AND incident_datetime>'2024-01-01T00:00:00'",   limit: 40 },
  { name: "divergent", where: "initial_call_type!=final_call_type AND incident_datetime>'2024-01-01T00:00:00'",                    limit: 80 },
  { name: "control",   where: "initial_call_type=final_call_type AND incident_datetime>'2024-01-01T00:00:00'",                     limit: 20 },
] as const;

export const SEED_TARGET = 40;
export const SEED_DEFAULT_TEMPLATED = true;   // LLM generation is opt-in via --llm
export const SEED_STRATA = { uncArrest: 15, sickCard: 15, other: 10 } as const;
export const CURATED_POSTMORTEM_CAP = 3;
export const REMEDIATION_FAILURE_FLOOR = 10;

/** NASEMSO chapters worth embedding for this demo. If section detection cannot isolate them, fall back to the full PDF rather than spending 20 minutes on a better splitter. */
export const RUNBOOK_CHAPTER_FILTER = [
  "Cardiovascular", "Cardiac", "Airway", "Respiratory", "Altered",
  "Toxicology", "Overdose", "Field Triage",
] as const;
```

Pitch numbers and reclassification priors are **Socrata aggregate queries** (`$select=count(1)` / `$group`). They return tens of rows, never millions, and are cached to `data/pitch-numbers.json` and `data/reclass-priors.json`. Those files are what the slides and the brief read on stage — never a live network call during the pitch.

