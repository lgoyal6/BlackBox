# BlackBox — Project Overview

> **Read this first,** then `.ralph/contracts.md` (the shared interface every phase codes against), then `.ralph/agents.md`, then your own phase spec in `.ralph/specs/`.

## What We're Building

BlackBox is a voice-native flight recorder and recall system for EMS crews. During an active emergency call it listens to the medic over an earpiece, captures the **decisions they make and the reasons they give**, writes those to MongoDB Atlas as embedded documents, drafts the patient care report at transfer of care, and then retrieves that reasoning on the next similar call to brief the next crew.

One Next.js application. A LangGraph agent checkpointed to Atlas, an ElevenLabs conversational voice layer with real tools that read and write Atlas mid-call, and a read-only dashboard that exists purely so judges can watch the database writes happen.

## Why

Every incident-response agent on the market stores what *happened* — action logs, postmortems, ePCR fields. Nobody stores what the human *decided and why*. That reasoning currently dies in radio chatter and scrollback.

Voice is the only capture medium that gets it, because during an active call nobody is typing. An EMT's hands are never free.

**The number, measured from the data this project runs on** (verified against the live Socrata API on 2026-08-13, not cited from a paper):

| Metric | Value | Query basis |
|---|---|---|
| NYC EMS incidents on record | **29,978,154** | full dataset, 2005→present |
| Calls where the final call type differed from dispatch (2023+) | **845,887 of 5,653,498 = 15.0%** | `initial_call_type != final_call_type` |
| Same, all time | 2,750,007 of 29,978,154 = 9.2% | |
| Calls **undertriaged** — severity upgraded after arrival (2023+) | **400,548 = 7.1%** | `final_severity_level_code < initial_severity_level_code` |
| Incidents that had to be reopened | 237,210 = 0.79% | `reopen_indicator = 'Y'` |

Lead the pitch with the 15.0% figure: **one in seven New York EMS calls turns out to be something other than what it was dispatched as.** Every one of those is a labeled case where the first read was wrong, and the reasoning behind the correction was never recorded anywhere.

## The Three Consequences (the differentiator — do not lose these)

Any implementation decision that weakens one of these is wrong, even if it saves time.

1. **Capture decisions with rationale, not just actions.** "Skipping the supraglottic, family reports recent neck surgery" is a decision *plus a reason*. The rationale is the embedded field that gets retrieved on the next similar call. A decision document without a `rationale` is a bug, enforced by a database validator.
2. **Store failures, not only successes.** A remediation or route that cost time is more valuable in memory than one that worked. `remediations.outcome` must support failure and retrieval must actively surface failures.
3. **Close the loop end to end.** Call happens → voice captures decisions → agent drafts the report at transfer of care → report is embedded → next call retrieves it. That full circle inside one demo *is* the hackathon theme.

## Event Context (this constrains everything)

**Persistent Context Sprint Hackathon**, MongoDB .Local Build Fest, Pier 48 San Francisco, **August 13 2026**. Build time is under one day. The theme is agent memory: MongoDB as the single platform for memory, state, context, and retrieval — **no third-party vector store, cache, queue, or connector.** Do not introduce Pinecone, Chroma, Redis, pgvector, or a message broker for any reason. MongoDB is even the event bus (see Architecture).

**Required stack:** MongoDB Atlas, LangGraph, ElevenLabs.

**ElevenLabs prize criteria and how BlackBox maps to each:**

| Criterion | How BlackBox satisfies it | Phase |
|---|---|---|
| Agentic Depth | Real tools that query Atlas and write decision documents mid-call. Not a TTS layer reading pre-generated text. | 11, 13 |
| Interaction Design | Barge-in is mandatory. Tone shift: calm during the brief, clipped when confirming something irreversible. | 13 |
| Technical Integration | Aviation-style readback — the agent repeats every drug and dose verbatim and waits for confirmation before it is written. Real EMS practice, real safety mechanism, and it doubles as the LangGraph human-in-the-loop gate. | 08, 13 |
| Novelty | Recording human reasoning as retrievable memory. | 06, 07, 09 |

## Decisions Already Locked

| Decision | Value | Rationale |
|---|---|---|
| Name | **BlackBox** | Chosen by the operator despite the collision with the existing BlackBox coding assistant. Repo, package name, dashboard header, and slides all say BlackBox. Do not reintroduce Flight Recorder / Squawk / CVR naming anywhere. |
| Stack | **Next.js 16.3 (App Router) + React 19 + TypeScript**, Node runtime | Single app, single deploy, single language. All package versions verified available on 2026-08-13. |
| Demo feed dataset | **NYC only** (`76xm-jjuj`) | One ingestion path, one schema. SF `nuek-vuh3` is cut — unit-response level, needs collapsing by call number, and lacks the initial-vs-final call type pairing the entire memory thesis depends on. |
| Event transport | **Server-Sent Events over a MongoDB change stream** | Not WebSocket. See Architecture — this is a hard Next.js constraint turned into an advantage. |
| Voice transport | **Browser WebRTC via `@elevenlabs/react`**, Twilio outbound optional | See Voice Transport Risk. |
| Demo scenario pair | **Call 1: `UNC` → `ARREST`. Call 2: `SICK` → occult cardiac.** | Both are real high-volume NYC transitions (`UNC`→`ARREST` = 14,987 incidents 2023+; `SICK`→`CARD` = 15,966). Different dispatch labels, different presenting symptoms, same latent pattern: a dispatch code that understates a cardiac event. That is a *variant*, not a repeat, so vector retrieval visibly does semantic work instead of looking like a string lookup. Script in PHASE-15. |
| Corpus size | **Demo slice, not the 30M-row dataset.** ~180 incidents in Atlas, ~40 seeded postmortems, NASEMSO chapters relevant to the two demo calls. | A hackathon demo needs retrieval to look real, not a warehouse. The 15.0% pitch number still comes from four Socrata `COUNT` aggregates over the full city dataset — those return one number each and never download a row. **Never hit the bulk CSV.** Constants live in `contracts.md` §14. |
| Seed narratives | **`--templated` is the default.** LLM generation is an optional upgrade. | Forty deterministic templates still retrieve. Four hundred LLM calls eat the phase budget and fail at a nonzero rate with no recovery window before the pitch. |

## Verified Package Versions (checked against the registry on 2026-08-13)

| Package | Version | Note |
|---|---|---|
| `next` | 16.3.0 | App Router, Turbopack default, **async request APIs** — `params` is a `Promise` in route handlers |
| `react` / `react-dom` | 19.2.8 | |
| `mongodb` | 7.5.0 | Node driver. Must be listed in `serverExternalPackages` |
| `@langchain/langgraph` | 1.4.9 | v1 API — `interrupt()`, `Command`, `StateGraph`, `Annotation` |
| `@langchain/langgraph-checkpoint-mongodb` | 1.4.0 | `MongoDBSaver` |
| `@langchain/core` | 1.2.7 | |
| `@langchain/openai` | 1.5.7 | |
| `@elevenlabs/react` | 1.12.0 | `useConversation` — browser WebRTC + client tools |
| `@elevenlabs/elevenlabs-js` | 2.63.0 | Server SDK. **Use this, not the legacy `elevenlabs` package (1.59.0)** |
| `unpdf` | 1.8.1 | PDF text extraction in Node. Preferred over `pdf-parse` |
| `voyageai` | 0.4.0 | Optional — the REST API via `fetch` is fine and one less dependency |
| `openai` | 7.4.0 | |
| `zod` | 4.4.3 | **v4** — `z.output`/`z.input`, stricter error API than v3 |
| `tsx` | 4.23.12 | Runs every `scripts/*.ts` |

## Parallel Execution Model

**Every phase after PHASE-01 can be built simultaneously by a different agent.** Three mechanisms make that true, and all three are mandatory:

### 1. Contracts first

`.ralph/contracts.md` specifies every shared type, collection name, document shape, port interface, API route signature, and event shape **verbatim**. PHASE-01 turns it into `src/lib/contracts/`. After that, no phase invents a shared type and no phase waits on another to discover one.

If your phase needs a shared type that is not in `contracts.md`, that is a contract change: **stop, add it to `contracts.md`, note it in `agents.md`, and only then implement.** Silently adding a shared type in your own phase is how parallel work turns into a merge conflict at hour seven.

### 2. Ports and fakes

Every cross-phase dependency is an interface (a "port"), and PHASE-01 ships a **deterministic fake for every port**. Resolution is by environment variable through a registry that no phase ever edits.

| Port | Real implementation | Fake | Env switch |
|---|---|---|---|
| `EmbeddingsPort` | PHASE-03 | hash → unit vector, correct dimension | `EMBEDDINGS_MODE=fake` |
| `RetrievalPort` | PHASE-07 | fixture hits from `fixtures/hits.json` | `RETRIEVAL_MODE=fake` |
| `MemoryPort` | PHASE-09 | in-memory ids, still rejects empty rationale | `MEMORY_MODE=fake` |
| `LlmPort` | PHASE-01 (thin) | canned templated strings | `LLM_MODE=fake` |
| `EventsPort` | PHASE-10 | append to an in-memory array | `EVENTS_MODE=fake` |
| `GraphPort` | PHASE-08 | scripted state transitions | `GRAPH_MODE=fake` |
| `VoicePort` | PHASE-13 | logs the utterance it would speak | `VOICE_MODE=fake` |

So PHASE-04 (ingestion) is built and verified with fake embeddings, PHASE-08 (graph) with fake retrieval, PHASE-14 (dashboard) with a fixture event stream. **Every phase must pass its own acceptance criteria with all other ports faked.** That is the definition of parallel-safe here, and it is a criterion in every spec.

### 3. Disjoint file ownership

**No file is owned by two phases.** If your spec does not list a file, do not create or edit it.

| Phase | Owns | May import from |
|---|---|---|
| 01 | `package.json`, `tsconfig.json`, `next.config.ts`, `.env.example`, `.gitignore`, `README.md`, `src/lib/contracts/**`, `src/lib/ports.ts`, `src/lib/fakes/**`, `src/lib/registry.ts`, `src/lib/db/client.ts`, `src/lib/llm.ts`, `src/lib/env.ts`, `scripts/check-atlas.ts`, `fixtures/**` (except `curated-postmortems.json`) | — |
| 02 | `src/lib/db/indexes.ts`, `src/lib/db/validators.ts`, `scripts/create-indexes.ts` | 01 |
| 03 | `src/lib/embeddings/**` | 01 |
| 04 | `src/lib/ingest/nyc.ts`, `scripts/ingest-incidents.ts`, `scripts/compute-pitch-number.ts` | 01 |
| 05 | `src/lib/ingest/runbooks.ts`, `scripts/ingest-runbooks.ts` | 01 |
| 06 | `src/lib/memory/seed.ts`, `scripts/seed-memory.ts`, `fixtures/curated-postmortems.json` | 01 |
| 07 | `src/lib/retrieval/**`, `scripts/verify-retrieval.ts` | 01 |
| 08 | `src/lib/graph/**`, `scripts/run-graph-local.ts`, `scripts/kill-resume-drill.ts` | 01 |
| 09 | `src/lib/memory/index.ts`, `src/lib/memory/decisions.ts`, `src/lib/memory/postmortem.ts`, `src/lib/memory/epcr.ts` | 01 |
| 10 | `src/lib/events/**`, `app/api/events/route.ts` | 01 |
| 11 | `app/api/tools/**`, `app/api/demo/**`, `app/api/state/**`, `app/api/counters/**` | 01 |
| 12 | `worker/**` | 01 |
| 13 | `src/lib/voice/**`, `app/voice/**`, `app/api/voice/**`, `scripts/setup-agent.ts` | 01 |
| 14 | `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `src/components/**`, `tailwind.config.ts` | 01 |
| 15 | `scripts/demo-*.ts`, `docs/**` | 01 |
| 16 | `scripts/integrate.ts`, `scripts/smoke.ts` | 01; **serial after 02–15** |

Every phase imports **only** from `src/lib/contracts/`, `src/lib/ports.ts`, `src/lib/registry.ts`, and its own files. Never import another phase's module directly — go through the registry. This is what lets fourteen agents work at once without reading each other's code.

## Architecture

### Why SSE over a MongoDB change stream, and not WebSocket

Next.js App Router route handlers cannot upgrade to WebSocket without a custom server, and a custom server means giving up Turbopack dev ergonomics on a day when nobody has time for that. Route handlers **can** return a long-lived `ReadableStream`, which is exactly Server-Sent Events, and the dashboard is one-directional anyway.

That turns into a genuine advantage: **MongoDB is the event bus.**

- Any process — a route handler, the worker, a `tsx` script — inserts into the `events` collection
- The SSE route opens a **change stream** on `events` and pushes each one to the browser
- Replay after a browser reload is a plain `find()` — no in-memory ring buffer to lose
- Multi-process coordination is free, so the worker and the Next app need no IPC
- It honors the hackathon's central constraint literally: MongoDB is the memory, the state, the context, **and the transport**. No Redis, no broker.

When a judge asks whether the dashboard is real, the answer is that every number on it arrives via an Atlas change stream.

### MongoDB Atlas collections

| Collection | Contents | Index |
|---|---|---|
| `incidents` | Live document per call: status, CAD fields, `timeline` array appended continuously | standard |
| `decisions` | **The black box.** Medic utterance, options considered, action chosen, spoken rationale, timestamp, outcome | vector |
| `remediations` | Action, incident id, outcome, duration, side effects. Failed ones are the valuable ones | vector |
| `runbooks` | NASEMSO clinical guidelines, chunked by protocol section | vector |
| `postmortems` | Auto-generated at call close, embedded on write | vector |
| `events` | The event bus. Change-streamed to the dashboard | standard, TTL |
| `checkpoints` + `checkpoint_writes` | LangGraph `MongoDBSaver` collections | managed by the saver |

`decisions` **stays empty until the demo.** It gets populated live from the voice call. That is the point — do not seed it.

Retrieval fans out across `decisions`, `postmortems`, and `runbooks` **in a single Atlas aggregation pipeline** using `$vectorSearch` + `$unionWith`, then reranks with reciprocal rank fusion. Three sources in one pipeline is exactly what the MongoDB judges want to see (PHASE-07).

### LangGraph graph

```
Trigger (change stream on incidents)
  → Triage
  → Signature Match      (vector search: have we seen this pattern)
  → Brief                (voice out)
  → Plan                 (retrieves failure memory to EXCLUDE known-bad paths)
  → Readback Gate        (interrupt() — human confirms verbatim)
  → Execute / Record
  → Verify
  → Record Decision
  → [on call close] Postmortem Generator → embed → write
```

`Signature Match` and the failure-exclusion logic in `Plan` are the two nodes that make this a memory project instead of a runbook lookup. **Never cut them.** If `Plan` is not visibly excluding a path because memory says it failed before, this is a dictation tool.

The graph parks at `interrupt()` between medic turns, which fits Next.js route handlers perfectly: every invocation is short and the durable state lives in Atlas.

### Runtime processes

| Process | Command | Purpose |
|---|---|---|
| Next app | `npm run dev` | UI, SSE, tool routes, graph invocation |
| Worker | `npm run worker` | Change stream on `incidents` → fires the graph. Long-lived, cannot be a route handler |
| Scripts | `npx tsx scripts/*.ts` | Ingestion, seeding, index creation, drills |

## The Stage Moment (rehearse three times, never cut)

LangGraph `interrupt()` at the readback gate with `MongoDBSaver` as the checkpointer. Mid-demo, with the agent waiting on a drug-dose confirmation, **kill the process in front of the judges and restart it.** The agent resumes the call where it left off.

The black box survives the crash. Fifteen seconds, thematically perfect, and the only part of the demo that is hard to fake. Point at the dashboard's checkpoint counter immediately before killing the process.

**Never construct a `MemorySaver` anywhere in this repo, including in tests.** With an in-memory saver, `interrupt()` still appears to work inside one process and the kill-and-resume fails on stage with no warning. Highest-consequence rule in the build.

## How It Operates For A Medic

The medic has **no screen** during the part that matters. Earpiece plus phone in a chest pocket. The system calls them, not the reverse. Say this out loud in the pitch.

- **Phase 1 — En route (~60s in the rig).** Change stream fires on a new CAD record and rings the medic. Brief is under fifteen seconds and is entirely retrieval: what this call type usually turns into, what went wrong on similar runs, which receiving facility was on diversion last time. Medic can barge in and ask anything.
- **Phase 2 — On scene.** Two jobs at once. The medic narrates what they are doing, which becomes the timeline. When they ask for something back, the agent retrieves from NASEMSO guidelines and reads it aloud. Every drug and dose gets read back verbatim before it is written. The agent listens for *reasoning*, not just actions.
- **Phase 3 — Transfer of care.** The patient care report drafts itself from the recording. This is what sells it to real medics — ePCR documentation is the most hated part of the job. The narrative is embedded and becomes what the next crew retrieves.

## Scope Guardrail (hard constraint)

Keep the agent on the side of **"recall what happened last time and write down what you decided."** The human owns every clinical judgment. **The agent must never propose a treatment, dose, or diagnosis of its own.** It may only read back what the medic said, or quote a retrieved NASEMSO passage with attribution.

Eva, the prior Best-ElevenLabs winner this is modeled on, won on documentation and retrieval, not diagnosis. Judges get visibly twitchy about AI making clinical calls. This constraint is encoded in the system prompt (PHASE-13) and in the `Plan` node's output filter (PHASE-08), and must not be softened to make a demo beat land better.

## Data Sources

### Primary — NYC EMS Incident Dispatch Data (`76xm-jjuj`)

**Endpoint pattern verified live on 2026-08-13.** No auth required.

- SODA JSON: `https://data.cityofnewyork.us/resource/76xm-jjuj.json` — used only with small `$limit` slices and `$select=count(1)` aggregates. **Never** `rows.csv?accessType=DOWNLOAD`.
- Code mapping attachment: `https://data.cityofnewyork.us/api/views/76xm-jjuj/files/1f3c87df-ffa3-4bda-a63c-45aeac003a26?download=true&filename=EMS_incident_dispatch_data_description.xlsx`

**The JSON API returns lowercase snake_case keys that differ from the portal's documented uppercase names. The identifier is `incident_id`, NOT `CAD_INCIDENT_ID`.** Verified sample row keys:

```
incident_id, incident_datetime, initial_call_type, initial_severity_level_code,
final_call_type, final_severity_level_code, first_assignment_datetime,
valid_dispatch_rspns_time_indc, dispatch_response_seconds_qy, first_activation_datetime,
first_on_scene_datetime, valid_incident_rspns_time_indc, incident_response_seconds_qy,
incident_travel_tm_seconds_qy, first_to_hosp_datetime, first_hosp_arrival_datetime,
incident_close_datetime, held_indicator, incident_disposition_code, borough,
incident_dispatch_area, zipcode, policeprecinct, citycouncildistrict,
communitydistrict, communityschooldistrict, congressionaldistrict,
reopen_indicator, special_event_indicator, standby_indicator, transfer_indicator
```

Why this dataset: `initial_call_type` vs `final_call_type` is millions of rows of real, labeled triage error — the memory signal. The severity codes give under/over-triage as a numeric delta. `reopen_indicator` is pre-labeled failure memory. The response-time fields give real MTTR numbers for the closing slide instead of invented ones.

**Severity code direction — resolved empirically, do not re-derive.** The portal publishes no key. Mean `incident_response_seconds_qy` by `initial_severity_level_code` is monotonic, so **lower code = higher severity**:

| Code | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Mean response (s) | 309 | 421 | 421 | 587 | 685 | 732 | 964 | 2837 |

Therefore `final_severity_level_code < initial_severity_level_code` means the call was **upgraded** — undertriaged on the initial read. Codes `0` (1 row) and `9` (310 rows) are noise: filter to 1–8. `final_call_type` is never null across all 30M rows, so `!=` in SoQL is safe without null guards.

### Runbook corpus — NASEMSO National Model EMS Clinical Guidelines v3 (2022)

**Use the Utah mirror. The nasemso.org URL returns 403 to non-browser clients** (verified 2026-08-13):

- ❌ `https://nasemso.org/wp-content/uploads/National-Model-EMS-Clinical-Guidelines_2022.pdf` → **403 Forbidden**
- ✅ `https://ems.utah.gov/wp-content/uploads/sites/34/2024/05/National-Model-EMS-Clinical-Guidelines_2022.pdf` → **200, `application/pdf`, 5,040,475 bytes**

Ideal vector corpus because it is already chunked by protocol — each guideline is a discrete section with indications, contraindications, and steps. Split on section headers. It also reads well aloud, which matters when ElevenLabs is speaking it back.

### Cut / not used

- **NEISS free-text narratives** — #4 on the cut list, and cutting is expected. NASEMSO alone is enough corpus.
- **NEMSIS** — requires a request form to the NEMSIS TAC, so it is a same-day non-starter. **Still cite it in the pitch as the production path.** Worth saying to signal domain knowledge: NEMSIS data is event-based, not patient-based, so one patient can appear across multiple records. The 2025 Public-Release Research Dataset covers ~63M EMS activations from ~15,000 agencies across 54 states and territories.
- **SF DataSF `nuek-vuh3`** and **Synthea** — cut by decision.

## Voice Transport Risk (read before PHASE-13)

1. **Browser WebRTC via `@elevenlabs/react`'s `useConversation`** — lowest risk, no audio drivers, real barge-in, real latency, and it is a first-class React hook so it belongs in this stack. **Build this first and make the demo work on it.**
2. **Twilio outbound call via ElevenLabs' native integration** — an actual phone actually rings on stage, which is worth real points because the pitch claims the system calls the medic. Needs a Twilio account, a purchased number, and the integration configured. **Timebox to 30 minutes as an upgrade, not a dependency.**
3. **Anything requiring native audio bindings** — do not. There is no time to debug native modules today.

Because the agent's tools are **server tools hitting our own Next.js route handlers**, all transports run identical logic.

## Atlas Vector Index Budget (blocker — settle this in PHASE-01, minute one)

This project needs **four** vector search indexes (`decisions`, `remediations`, `runbooks`, `postmortems`). **Atlas M0 free-tier clusters cap you at 3 search indexes.** Discovering this at hour six is fatal.

- **Preferred:** provision a **Flex** (or dedicated) cluster, which raises the cap. Costs a few dollars, five minutes of work.
- **Documented Plan B only if stuck on M0:** merge `decisions`, `remediations`, and `postmortems` into one `memory` collection discriminated by a `kind` field, giving 2 indexes. This weakens the "three collections in one aggregation" story the MongoDB judges specifically reward, so treat it as a real loss and take the Flex cluster instead.

The MongoDB MCP server is configured in this environment — use `atlas-list-clusters` and `atlas-inspect-cluster` to check the tier rather than clicking through the UI.

## Judge-Facing Dashboard

**A pixel reference exists at `reference.png` in the repo root. PHASE-14 must match it.** Read it before writing any UI.

The medic never looks at a screen — say that out loud in the pitch. The dashboard is a window into the black box, not the product.

- **Header:** incident id (`YYMMDD-NNNN` format), expanded call type, dispatch area, unit, elapsed timer, recording pill
- **Left ~60% — voice timeline:** timestamped turns, medic vs agent distinguished by color, decision captures rendered as a highlighted bordered block, pending readbacks as an amber "Awaiting readback" pill
- **Right ~40% — memory:** Atlas vector search hits with similarity scores, one retrieved snippet in full, and live write counters per collection
- **Footer:** LangGraph node chain with the active node highlighted, and the checkpoint counter

Keep it visually calm. Emergency dashboards pull hard toward flashing red and sirens; that reads as theater. A clean recorder readout reads as a product.

## Critical Rules

1. **MongoDB Atlas is the only datastore, and also the event bus.** No third-party vector DB, cache, queue, or broker. Violating this disqualifies the entry from the track.
2. **Never use an in-memory LangGraph checkpointer.** `MongoDBSaver` only, everywhere, including tests.
3. **The agent never proposes clinical treatment.** It reads back what the medic said or quotes retrieved guidance with attribution. No exceptions for demo polish.
4. **Every decision document must carry a non-empty `rationale`,** enforced by both the writer and a server-side JSON Schema validator.
5. **Never seed the `decisions` collection.** It fills live during the demo, on stage.
6. **Strip the answers from `incidents` on ingest.** `final_call_type`, `final_severity_level_code`, and `incident_close_datetime` live only under `_groundTruth` (camelCase, matching `IncidentDoc`). No retrieval path or graph node may read it.
7. **`incident_id` is the identifier, not `CAD_INCIDENT_ID`.**
8. **Failures are first-class.** Any code path that filters `remediations` to successes only is wrong.
9. **Own only your phase's files.** Cross-phase access goes through `src/lib/registry.ts`. Never import another phase's module directly.
10. **Contract changes are announced.** Update `.ralph/contracts.md` and `.ralph/agents.md` before implementing one.

## Cut List (in this order, if behind)

1. Real execution — simulate any action; no judge will check
2. Change streams for the trigger — swap the worker to polling (`TRIGGER_MODE=poll`)
3. SF dataset — already cut
4. NEISS narratives — NASEMSO alone is enough corpus

**Never cut:** signature match, failure memory, the readback gate, the kill-and-resume, the second call.

## Milestones

PHASE-01 is the only prerequisite. Everything after it runs in parallel; the milestones below describe *review* groupings, not execution order.

| Milestone | Phases | Outcome |
|---|---|---|
| M0 Contract | 01 | Types, ports, fakes, fixtures, scaffold. Unblocks all 14 remaining phases |
| M1 Data | 02–06 | Collections + vector indexes, embeddings, NYC incidents, NASEMSO corpus, seeded memory |
| M2 Brain | 07–09 | Three-collection fan-out, LangGraph with `interrupt()`, decision/postmortem/ePCR writers |
| M3 Surface | 10–14 | Event bus + SSE, tool routes, change stream worker, ElevenLabs voice, judge dashboard |
| M4 Stage | 15 | Two-call demo scripted; kill-and-resume rehearsed 3× |
| M5 Cutover | 16 | All seven ports flipped from fake to real; one smoke path through fire → brief → readback → decision → close |

## Environment Variables

All new — greenfield repo. `NEXT_PUBLIC_*` are the only ones exposed to the browser; **no API key ever gets that prefix.**

```env
# --- MongoDB (required) ---
MONGODB_URI=mongodb+srv://...            # Flex or dedicated tier, NOT M0 (see index budget)
MONGODB_DB=blackbox

# --- Embeddings (required; Voyage preferred, it is MongoDB-owned) ---
EMBEDDING_PROVIDER=voyage                # voyage | openai
VOYAGE_API_KEY=
EMBEDDING_MODEL=voyage-3-large
EMBEDDING_DIM=1024                       # MUST match the vector index numDimensions
# openai fallback: EMBEDDING_MODEL=text-embedding-3-small, EMBEDDING_DIM=1536

# --- LLM for graph nodes, postmortem + ePCR generation (required) ---
OPENAI_API_KEY=
LLM_MODEL=gpt-4.1-mini

# --- ElevenLabs (required) ---
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=                     # written back by scripts/setup-agent.ts
ELEVENLABS_VOICE_ID=
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=         # public agent id for the browser session

# --- App ---
PUBLIC_BASE_URL=                         # tunnel URL; ElevenLabs server tools must reach this
TOOL_SHARED_SECRET=                      # X-BlackBox-Secret header on /api/tools/*
TRIGGER_MODE=changestream                # changestream | poll

# --- Port modes: set to `fake` to build a phase in isolation ---
EMBEDDINGS_MODE=real                     # real | fake
RETRIEVAL_MODE=real
MEMORY_MODE=real
LLM_MODE=real
EVENTS_MODE=real
GRAPH_MODE=real
VOICE_MODE=real
NEXT_PUBLIC_EVENTS_MODE=real             # real | fixture (dashboard reads fixtures/event-stream.json)

# --- Optional ---
SOCRATA_APP_TOKEN=                       # raises Socrata rate limits; ingestion works without it
TWILIO_ACCOUNT_SID=                      # only for the outbound-call upgrade
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
DEMO_MEDIC_PHONE=
```
