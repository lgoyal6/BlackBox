# Agents — Long-Term Memory & Patterns

> Persistent knowledge for every agent working on BlackBox. **Update this file whenever you discover a gotcha, make a technical decision, or change the contract.** Fourteen phases run in parallel; this file is how they learn from each other without reading each other's code.

## Project Conventions

### Code Style

- **Next.js 16.3 App Router, React 19.2, TypeScript strict.** No `any` in an exported signature.
- Path alias `@/*` → `src/*`. Import shared code as `import { INCIDENTS } from "@/lib/contracts"`.
- **Zod v4** (4.4.3) for every route body. Handler parameter types come from `z.output<typeof Schema>`. The v4 error API and issue shapes differ from v3 — do not copy v3 patterns from memory.
- Scripts are TypeScript run with `tsx`, never compiled separately. Every script is registered in `package.json` by PHASE-01.
- Tailwind for styling. No component library, no charting library — the dashboard is a handful of cards and a dependency costs more time than it saves.
- Dates are `Date` objects everywhere. Never store an ISO string in a date field.

### Parallel Work Patterns

- **Own only your phase's files** (see the ownership table in `overview.md`). If your spec does not list a file, do not create or edit it.
- **Import only** from `@/lib/contracts`, `@/lib/ports`, `@/lib/registry`, `@/lib/db/client`, and your own files. Never import another phase's module directly — go through the registry.
- **Set the `*_MODE` env vars of the ports you consume to `fake`** while building. Every phase must pass its own acceptance criteria with all other ports faked.
- If you implement a port, **default-export an object satisfying it from the exact path the registry expects** (`src/lib/<name>/index.ts`). That is the entire integration contract.
- A shared type not already in `contracts.md` is a **contract change**: update `contracts.md`, log it below, then implement.

### Database Patterns

- Collection names come from `@/lib/contracts` constants. Never write a collection name as a literal anywhere else.
- Every vector write sets **both** `embedding` and `embeddedText`. The text is what makes retrieval debuggable at hour seven.
- Every agent-facing read of `incidents` uses `PUBLIC_INCIDENT_PROJECTION` to exclude `_groundTruth`.
- Writes that the demo shows off go through code that emits an event, so the dashboard sees them.

### API Route Patterns

- Every route handler: `export const runtime = "nodejs"`. The Mongo driver cannot run on the edge runtime.
- Errors are always `{ error: string }` with 400 for validation, 401 for a bad shared secret, 404 for not found, 500 for internal.
- Tool routes validate with Zod and check `X-BlackBox-Secret` before doing anything else.

## Known Gotchas

### Verified against live services on 2026-08-13

- **Socrata column names differ from the portal docs.** The JSON API returns lowercase snake_case, and the identifier is **`incident_id`, not `CAD_INCIDENT_ID`**. Every value arrives as a string, including numbers and naive datetimes like `2005-01-01T00:00:24.000`.
- **Socrata paging without `$order` is non-deterministic** — you get duplicate and missing rows. Always send `$order=incident_id`.
- **An unencoded `$where` returns an empty body with HTTP 200.** No error, just nothing, which reads as "the dataset has no such rows." Two of my own exploratory queries failed exactly this way before I encoded the spaces. Always pass params through `URLSearchParams`; never hand-build the query string.
- **`nasemso.org` returns 403 to non-browser clients** even with a browser User-Agent. Use the Utah mirror: `https://ems.utah.gov/wp-content/uploads/sites/34/2024/05/National-Model-EMS-Clinical-Guidelines_2022.pdf` (200, `application/pdf`, 5,040,475 bytes). Do not spend time on the WAF.
- **NYC severity codes have no published key.** Resolved empirically: mean response time rises monotonically from code 1 (309 s) to code 8 (2837 s), so **lower code = more severe**. Codes 0 and 9 are noise (1 and 310 rows) — filter to 1–8. Therefore `finalSeverity < initialSeverity` means the call was **upgraded**, i.e. undertriaged at dispatch.
- **`final_call_type` is never null** across all 29,978,154 rows, so `!=` comparisons need no null guard.
- **The dataset has no diversion field and no unit field.** The "facility on diversion" detail in the demo is synthetic and must be marked `origin: "curated"`; `cad.unit` is synthesized because `reference.png` displays one.

### MongoDB Atlas

- **M0 free clusters cap at 3 Atlas Search indexes and this project needs 4.** Settle the cluster tier in PHASE-01 minute one. Use the MongoDB MCP server (`atlas-list-clusters`, `atlas-inspect-cluster`) rather than clicking through the UI.
- **A vector index build takes 30–90 seconds, and querying before `status: "READY"` returns an empty array with no error.** This is indistinguishable from a broken query and is the most common false alarm in this build. Always poll to READY, and make the readiness check the *first* thing `verify-retrieval` prints.
- **`EMBEDDING_DIM` must equal every vector index's `numDimensions`.** A mismatch returns zero results silently. Assert it at both write time and index-creation time.
- **`$vectorSearch` must be the first stage of the pipeline it appears in**, including inside a `$unionWith` sub-pipeline. `{$meta: "vectorSearchScore"}` must be captured immediately after its own `$vectorSearch`, inside the same sub-pipeline — reading it after the `$unionWith` returns nothing.
- **Vector `filter` paths must be declared as `filter` fields in the index definition** or the query errors at runtime.
- **Cosine scores from different collections are not comparable.** Sorting a union by raw score systematically favors the corpus with the tighter embedding distribution — usually `runbooks`, which buries exactly the memory hits this project exists to surface. Fuse by rank (RRF), not by score.
- **Cache the Mongo client on `globalThis` in development.** Next.js hot-reload re-evaluates modules on every edit, and a module-level `let` opens a new connection pool each time until Atlas refuses connections. The error will not mention hot reload.
- **Close change stream cursors on client disconnect.** A leaked cursor per browser reload exhausts the pool during rehearsal, and the failure looks like Atlas refusing connections rather than anything dashboard-related.

### LangGraph

- **On resume, LangGraph re-executes the interrupted node from the top.** Everything before the `interrupt()` call runs a second time. Put no writes, no emits, and no side effects before `interrupt()` — or make them idempotent. This is the single most expensive gotcha in the graph phase.
- **Never construct a `MemorySaver`, including in tests.** With an in-memory saver, `interrupt()` still appears to work inside one process and the kill-and-resume fails on stage with no warning.
- `thread_id` is always the `incidentId`. One thread per call.
- Confirm exact v1 export names against the installed `@langchain/langgraph` 1.4.9 types rather than guessing; the v0→v1 rename touched several symbols.

### Next.js 16

- **`params` is a `Promise` in route handlers** — `const { tool } = await params`. A Next 14/15 handler signature copied from memory will not compile.
- SSE routes need `export const dynamic = "force-dynamic"` and a heartbeat comment every ~15 s, or tunnels and proxies close the connection. This bites specifically through ngrok.
- `mongodb`, `unpdf`, and `@langchain/langgraph-checkpoint-mongodb` must be in `serverExternalPackages`, or the bundler traces optional native dependencies and fails with module-not-found errors for packages nobody installed.

### Voice

- **The ElevenLabs Agents API surface has moved** (Conversational AI → Agents Platform): the agent-create payload, tool schema format, and turn-taking keys have all changed names. Confirm against live docs via the Context7 MCP server before writing any payload. Writing it from memory and debugging a 422 against a moving API is the fastest way to blow the phase budget.
- **Use `@elevenlabs/elevenlabs-js` 2.63.0, not the legacy `elevenlabs` 1.59.0 package.**
- **Avoid anything needing native audio bindings.** Browser WebRTC via `@elevenlabs/react`'s `useConversation` has no such dependency.
- **Never speak an 8-digit incident id.** "One six nine seven five nine four two" is unusable in the field and sounds terrible on stage. Voice always uses the 4-digit `displayId`.
- **Never speak a raw dispatch code.** "UNC" from a TTS voice is unintelligible; use `labelFor`.
- **Cap anything spoken at 40 words.** A 200-word guideline chunk at TTS pace is 90 seconds of a medic listening to a robot, which fails the interaction-design criterion no matter how good the retrieval was.

### Failure modes to actively guard against

- **An agent that sounds right but never called a tool.** Indistinguishable from a working system until a judge asks what happens when the database is empty, and it is exactly the "TTS layer reading pre-generated text" that the Agentic Depth criterion filters out. Verify tool invocations in the server log, not just that speech happened.
- **A port silently resolving to a fake.** The registry logs `FAKE PORT`; the preflight greps for it and fails. At hour seven somebody will otherwise demo something that ran entirely on fakes.
- **A fabricated rationale.** Worse than no rationale: it puts a made-up justification in a permanent clinical record, which is the exact harm this project claims to prevent. Return `null` and let the agent ask.
- **Never download the NYC bulk CSV.** Atlas holds ~180 incident documents. City-wide statistics are four Socrata `COUNT` queries cached to `data/pitch-numbers.json`. The CSV is gigabytes and will eat the afternoon.

## Technical Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-13 | Keep the name **BlackBox** despite the collision with the existing BlackBox coding assistant | Operator's call. Repo, package, dashboard header, and slides must all agree; do not reintroduce Flight Recorder / Squawk / CVR anywhere. |
| 2026-08-13 | **NYC dataset only**; cut SF `nuek-vuh3` | SF is unit-response level, needs collapsing by call number, and lacks the initial-vs-final call type pairing the entire memory thesis rests on. One ingestion path is worth more than the "running on San Francisco's own data" line. |
| 2026-08-13 | Lead the pitch with **15.0%** (2023+) rather than the 9.2% all-time figure | Both are real; the recent window is higher, more defensible as current, and computed from 5,653,498 incidents. A number derived from the data on screen beats a cited statistic. |
| 2026-08-13 | Demo pair is **`UNC`→`ARREST`** then **`SICK`→ occult cardiac** | Both are real high-volume transitions (14,987 and 15,966 incidents in 2023+). Different dispatch labels and different presenting symptoms with the same latent pattern make call two a *variant*, so retrieval visibly does semantic work. Identical calls would make vector search look like a lookup table. |
| 2026-08-13 | **Next.js everywhere**, replacing the original Python plan | Operator's call. Verified that `@langchain/langgraph` 1.4.9 and `@langchain/langgraph-checkpoint-mongodb` 1.4.0 both exist, so `interrupt()` plus an Atlas-backed saver — the stage moment — is fully supported in TypeScript. |
| 2026-08-13 | **SSE over a MongoDB change stream** instead of WebSocket | App Router route handlers cannot upgrade to WebSocket without a custom server, and a custom server means losing Turbopack dev ergonomics today. Route handlers can return a long-lived `ReadableStream`, and the dashboard is one-directional anyway. |
| 2026-08-13 | **MongoDB is the event bus** (`events` collection + change stream) | Falls out of the SSE decision and turns a constraint into an advantage: replay after reload is a `find()`, multi-process needs no IPC, and it honors the "MongoDB as the single platform" rule literally — no Redis, no broker. "Every number on the dashboard arrives via an Atlas change stream" is a strong answer when a judge asks whether it is real. |
| 2026-08-13 | **Ports + deterministic fakes + disjoint file ownership** | The operator requires every phase to be buildable in parallel. Contracts-first with a fake for every port is what makes fourteen simultaneous agents possible without merge conflicts or blocking. |
| 2026-08-13 | **Embedding cache lives in Mongo** (`_embed_cache`), not a local file or Redis | The seed script gets re-run several times during the build, so the cache is genuinely useful, and a Redis dependency would invite exactly the wrong question from a judge on a MongoDB track. |
| 2026-08-13 | Voyage `voyage-3-large` primary, OpenAI `text-embedding-3-small` fallback | Voyage is MongoDB-owned, which is worth a sentence on stage. The fallback exists because a single missing API key should not block the build. |
| 2026-08-13 | **Curated postmortems capped at 2–3 and explicitly labeled `origin: "curated"`** | The diversion detail the agent quotes has no source field in the dataset, so it is synthetic. Attaching it to a real incident with real response times and a derived cost keeps it honest; keeping the count tiny keeps retrieval real rather than theater. Say which is which if asked. |
| 2026-08-13 | Curated code-label map instead of parsing the dataset's xlsx attachment | Parsing it needs a new dependency and reverse-engineering the sheet layout — roughly 15 minutes for codes the demo will never speak. Download the xlsx only if an unknown code appears in the slices. |
| 2026-08-13 | Browser WebRTC as the primary voice transport, Twilio outbound timeboxed to 30 min | An actual ringing phone is worth real points because the pitch claims the system calls the medic, but it is an upgrade and not a dependency. Native audio bindings are excluded outright — no time to debug native modules today. |
| 2026-08-13 | **Demo slice, not the 30M-row dataset.** ~180 incidents, 40 templated postmortems, NASEMSO chapters relevant to the two calls | A hackathon demo needs retrieval to look real, not a warehouse. The 15.0% pitch number still comes from four Socrata COUNT aggregates — one number each, never a row download. Never hit the bulk CSV. Constants in contracts.md §14. |
| 2026-08-13 | **`--templated` is the default** for seed narratives; LLM is opt-in | Forty deterministic templates still retrieve. Four hundred LLM calls eat the phase budget. |
| 2026-08-13 | **`RetrievalSource` includes `"remediations"`** with `SOURCE_WEIGHTS.remediations = 1.25` | `failureMemory` returns `Hit[]` and queries remediations; without this member there is no honest value for `Hit.source`. Fan-out stays three collections (`decisions`, `postmortems`, `runbooks`). |
| 2026-08-13 | **WebRTC uses `conversationToken` (`getWebrtcToken`), not a signed URL** | `@elevenlabs/react` 1.12.0: a `signedUrl` session is WebSocket-only; passing it with `connectionType: "webrtc"` throws. Added `VoicePort.conversationToken()` and `GET /api/voice/conversation-token`. The signed-url route stays for the WebSocket fallback. |

## Open Items

- Tune `SIGNATURE_MATCH_FLOOR` (currently 0.62) once real seeded data exists. It must still return `null` for demo call one so the agent can honestly say "new signature, no prior history."
- Confirm the exact `@langchain/langgraph` 1.4.9 export names for `interrupt` and `Command` against the installed types.
- Decide whether the Twilio outbound upgrade is attempted, based on remaining time after PHASE-13's browser transport works end to end.
