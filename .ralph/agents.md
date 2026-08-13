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

- **M0 free clusters cap at 3 Atlas Search indexes and this project needs 4.** Confirmed live on 2026-08-13: `vs_decisions`, `vs_remediations`, and `vs_runbooks` created at `numDimensions=1024` and reached READY; `vs_postmortems` failed with `The maximum number of FTS indexes has been reached for this instance size`. Upgrade the cluster to **Flex** (or dedicated), then re-run `npm run indexes`. Do not take Plan B — other phases already code against four collections.
- **Atlas `readWrite` cannot `collMod`.** Applying a validator to an existing collection fails with `user is not allowed to do action [collMod]`. Create `decisions` with the validator on `createCollection`. If an empty `decisions` already exists without one, drop it and recreate — `readWrite` can `dropCollection`.
- **Atlas MCP org access was disabled on 2026-08-13.** `atlas-list-projects` failed with: MCP access is disabled for every MongoDB Atlas organization this user belongs to. An Organization Owner has to enable AI client access. PHASE-01 could not confirm Flex vs M0 via MCP. `npm run check` still verifies replica set, `listSearchIndexes()`, and write access once `MONGODB_URI` is in `.env.local`. Do not silently take Plan B.
- **A vector index build takes 30–90 seconds, and querying before `status: "READY"` returns an empty array with no error.** This is indistinguishable from a broken query and is the most common false alarm in this build. Always poll to READY, and make the readiness check the *first* thing `verify-retrieval` prints.
- **`dropSearchIndex` is asynchronous.** Creating the same name while Atlas still reports `DELETING` fails. PHASE-02 waits until `listSearchIndexes(name)` returns empty before `createSearchIndex`.
- **TTL `IndexOptionsConflict` (code 85):** if `events_ttl_t` already exists with a different `expireAfterSeconds`, collMod it in place. Do not drop. mongod's TTL monitor sweeps once every 60 seconds, so an expired event can survive up to a minute past 24 hours — that is not a broken index.
- **You cannot set `EMBEDDING_DIM` to a value that disagrees with `EMBEDDING_MODEL`.** `assertEmbeddingConfig()` runs when `env.ts` loads and throws. Recreate-on-mismatch fires when *existing Atlas indexes* were built at a previous dimension (Voyage 1024 → OpenAI 1536). After a valid model+dim change, `npm run indexes` drops and rebuilds; `--drop-vector` is the manual recovery path.
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
- **`_groundTruth` is camelCase**, matching `IncidentDoc`. `overview.md` used to write `_ground_truth`; the contract spelling wins. `PUBLIC_INCIDENT_PROJECTION` excludes that field.
- **Socrata naive datetimes must be parsed as UTC.** `toDate` appends `Z` before `new Date()`. JavaScript otherwise treats the naive ISO as local time; with UTC getters in `toRef` that shifts early-morning NYC calls onto the previous calendar day. Do not "fix" the `Z` — a row of `2024-03-05T01:12:00.000` must produce a `ref` beginning `240305` on any laptop.
- **Socrata row slices should be fetched sequentially, with up to three attempts (120s each) and backoff.** Four parallel `$limit` requests timed out at 45s; sequential 90s was usually enough, but the Atlas ingest hit a 90s abort and needed a retry. Empty HTTP 200 bodies are still almost always an encoding bug, not a timeout.
- **A shell `MONGODB_URI` shadows `.env.local`.** `dotenv` does not override existing env. A leftover `mongodb://127.0.0.1` from a Docker test made `npm run check` look like Community Mongo (no replica set, no `$listSearchIndexes`) while `.env.local` already had Atlas. Clear `$env:MONGODB_URI` in PowerShell before relying on `.env.local`.
- **`date_extract_hh(incident_datetime)` works** for overnight priors (`>=22 OR <6`). Night-hour SoQL did not error on 2026-08-13; if it ever does, emit only `nightOnly: false` priors and keep going — the percentage is the load-bearing part of the spoken line.
- **Unlabeled codes in the 2024 demo slice (divergent/control only, not the UNC/SICK demo path):** `PEDSTR`×3, `ALTMEN`×2, `ANAPH`, `BURNMI`, `SICMIN`, `STATEP`, `STNDBM`, `STNDBY`. `verifyCodeLabels` printed them. Do not add them to `CODE_LABELS` unless a demo path starts speaking them; that map is PHASE-01 owned. Download the xlsx attachment only then.
- **Unpaid Voyage keys are 3 RPM and 10K TPM.** Confirmed live on 2026-08-13: `npm run ingest:runbooks` embeds a `WRITE_BATCH` of 200 (183 NASEMSO chunks in one call), which exceeds 10K TPM and 429s. `withRetry` backoff (500ms base, 4 attempts) is far too short for 3 RPM. **`deleteMany({ source })` runs before the first embed**, so a 429 leaves `runbooks` empty of that source. Recover by embedding ≤8 texts with ≥22s between calls, or add a payment method at dashboard.voyageai.com (the 200M free Voyage-3 tokens still apply). Do not re-run the stock script on an unpaid key.
- **No automatic embedding-provider failover.** `EMBEDDING_PROVIDER` is env-selected. Falling through from Voyage to OpenAI mid-run changes the vector dimension from 1024 to 1536 and silently empties `$vectorSearch`. Switch providers only by changing env and rebuilding the indexes. The documented four-minute fallback:
  1. Set `EMBEDDING_PROVIDER=openai`, `EMBEDDING_MODEL=text-embedding-3-small`, `EMBEDDING_DIM=1536`.
  2. Run `npm run indexes` — PHASE-02 detects the dimension mismatch and recreates all four vector indexes.
  3. Re-run `npm run ingest:runbooks` and `npm run seed` to rewrite the corpus at the new dimension.
- **`fanOut`'s `callTypeFamily` filter does not apply to runbooks.** `RunbookDoc` has no such field. PHASE-07 must omit it from the runbooks `$unionWith` leg or the pipeline errors.
- **`RunbookDoc.chunkIndex` is 0-based within its guideline.** A single-chunk guideline is always `0`. `(sectionTitle, chunkIndex)` is unique.
- **NASEMSO titles sit above an `Aliases` block.** Searching five lines back from `Patient Care Goals` hits synonym lists (`None noted`, drug names). Find `Aliases` first, then take the title above it. Wrapped titles (STEMI, ACS) need the previous line joined.
- **Chapter names are `Chapter Rev. March 2022` running headers**, not the `NASEMSO` boilerplate line. Prefer that `Rev.` pattern for `chapter`; otherwise everything becomes `"Guidelines"` and `RUNBOOK_CHAPTER_FILTER` under-matches.
- **unpdf splits list markers onto their own line**, often at a page boundary (`7.` then the step on the next page). Merge `^\d{1,2}\.$` with the following line or TTS reads a bare number and the hygiene check flags a page-number-only line.
- **Scratch files named `tmp-*.ts` break `tsc --noEmit`.** `tsconfig.json` excludes them. Do not check in verify scripts at the repo root.
- **Field-to-field `$ne` needs `$expr`.** `{ final: { $ne: "$cad.initialCallType" } }` compares to the literal string `"$cad.initialCallType"` and returns everything. Seed selection uses `$expr: { $ne: ["$_groundTruth.finalCallType", "$cad.initialCallType"] }`.
- **PowerShell + npm swallows `--target=20`.** `npm run seed -- --target=20` is parsed as an npm config. Use `npx tsx scripts/seed-memory.ts --target=20` or `cmd /c "npm run seed -- --target=20 ..."`. The script also accepts `--target 20` (space form).

### ws/runtime findings (PHASE-10–13, 2026-08-13)

**ElevenLabs field names, confirmed against the installed `@elevenlabs/elevenlabs-js` 2.63.0 and `@elevenlabs/react` 1.12.0 types — nobody needs to re-research these.**

- **Tools are their own registry.** `client.conversationalAi.tools.create({ toolConfig })` / `.update(toolId, {...})` / `.list()`, and the agent references them by `conversationConfig.agent.prompt.toolIds`. There is no inline tool array on the agent create payload worth using.
- A webhook tool is `{ toolConfig: { type: "webhook", name, description, responseTimeoutSecs, interruptionMode, apiSchema: { url, method, requestHeaders, requestBodySchema } } }`. `requestBodySchema` is a plain `{ type: "object", required: [...], properties: { name: { type, description } } }`.
- **`responseTimeoutSecs` must be between 5 and 300.** The 2–3 second budgets in PHASE-13's spec are below the platform minimum, so `SERVER_TOOLS[].timeoutMs` keeps the intended budget and `buildAgentConfig` clamps to 5 when building the payload. `close_call` is unaffected at 10.
- Agent create: `agents.create({ name, tags, conversationConfig })`, update: `agents.update(agentId, config)`. Response carries `agentId`.
- **Two credentials, two different SDK calls.** `conversations.getWebrtcToken({ agentId })` → `{ token, conversationId }` (WebRTC). `conversations.getSignedUrl({ agentId })` → `{ signedUrl }` (WebSocket). Not interchangeable.
- **`startSession` takes `{ conversationToken, connectionType: "webrtc" }` and the SDK types `agentId` as `never` alongside a token** — do not also pass `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` there, it will not compile. The token identifies the agent.
- **`useConversation()` must be rendered inside `<ConversationProvider>`** or it throws. Input level is `getInputVolume(): number`; status is `"disconnected" | "connecting" | "connected" | "error"`.
- Lowest-latency TTS tier in this SDK version is **`eleven_flash_v2_5`**. Barge-in: `conversationConfig.agent.disableFirstMessageInterruptions: false` plus per-tool `interruptionMode: "allow"`.
- **There is no server-side way to inject a message into a live conversation** in 2.63.0 — the `conversations` client is `getSignedUrl`, `getWebrtcToken`, and reads. So `VoicePort.speak` records (timeline append + `voice` event) and the brief is retrieved by a tool rather than pushed by the server. Nothing in the demo depends on server-initiated speech.

**Other cross-phase notes:**

- **`_watch_state` is shared and the sharing is deliberate.** PHASE-10 owns `seq:<incidentId>` / `seq:__global__`; PHASE-12 owns `watch:incidents`, `watch:writes`, `poll:incidents`. Verified coexisting. **Never `deleteMany({})` on it** — `/api/demo/reset` deliberately leaves it alone, which is why sequence counters never need resetting between rehearsals.
- **`@/lib/events` resolves to the ambient declaration in `src/lib/real-ports.d.ts`, which exports only the default.** A named import (`import { recent } from "@/lib/events"`) does not compile. Import the concrete path — `@/lib/events/index` — when you need named exports. Same trap applies to `@/lib/retrieval`, `@/lib/memory`, `@/lib/graph`, `@/lib/voice`.
- **The Mongo driver's collection generic needs an index signature, which an `interface` never gets implicitly.** `col<IncidentDoc>(INCIDENTS)` fails the `T extends Document` constraint, and `IncidentDoc & Document` breaks `$push` typing (`PushOperator` stops seeing `timeline` as an array). Use a mapped type: `type IncidentRecord = { [K in keyof IncidentDoc]: IncidentDoc[K] }`.
- **`fakes/llm.json()` cannot satisfy PHASE-13's `fixtures/utterances.json` expectations.** It returns one canned rationale, `"family reports recent neck surgery"`, for any prompt matching `/family|because|says|reports/`. That string is not a verbatim span of any fixture utterance (fixture 1 says "family **says**"), so the mandated substring guard correctly discards it and every fixture extracts to `rationale: null` under `LLM_MODE=fake`. Five fixtures expect a non-null rationale, so **that criterion needs `LLM_MODE=real`.** Four of the five fixture rationales are paraphrases rather than spans, so they are semantic targets, not literal expectations. PHASE-11's `record_decision` path is unaffected: its verification utterance says "family reports", which the fake returns verbatim.
- **Readback wording is locked to `Confirm: {dose} of {drug}, {route}. Say confirm.`** Both copies (`src/lib/voice/tools.ts`, `app/api/tools/_lib/readback.ts`) assert `composeReadback({ drug: "amiodarone", dose: "300 mg", route: "IV push" }) === "Confirm: 300 mg of amiodarone, IV push. Say confirm."` — verified identical.
- **`recent()` orders by `t` then `seq`, so under genuinely concurrent emits the returned page can invert two adjacent `seq` values** whose timestamps landed out of order (observed once in a 200-parallel-emit test). Sequential emission — every real path — is strictly ordered. PHASE-14's per-incident gap detection should tolerate a one-position inversion rather than report a dropped event.

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
| 2026-08-13 | Dashboard display rules locked: `status.startedAt`, absolute `write.count`, `timeline` as a write bucket, `GRAPH_STAGES` four-pill footer, Recording = not closed, rows show `Hit.score` | Pixel reference cannot be built from the event union without these. Highest-consequence: `write.count` must be absolute or SSE replay double-counts the counters the presenter points at. |
| 2026-08-13 | Store Socrata naive timestamps as UTC instants (`toDate` appends `Z`) | Nothing in this project does cross-timezone arithmetic. The dashboard clock wants the original wall-clock reading, and any other choice makes `ref` change when the laptop travels. |
| 2026-08-13 | Pitch-number drift trusts the fresh Socrata count, sets `drift: true`, and prints a loud block naming both values | The slide and `data/pitch-numbers.json` must never disagree on stage. Editing `overview.md` is a deliberate act, not a side effect of `npm run pitch -- --refresh`. |
| 2026-08-13 | Spoken reclass priors come from `data/reclass-priors.json`, never from the 18% figure in `reference.png` | Population 2023+ `SICK`→`CARD` is 2.6% (15,966 / 618,152); `UNC`→`ARREST` is 4.3% (14,987 / 348,246). B3 `SICK`→`CARD` is 2.9%. The mockup 18% is illustrative. |
| 2026-08-13 | Runbook `sectionPath` is `[chapter, title]` for every chunk; subsection headings stay in `text` | Real NASEMSO guidelines are 4–12 pages. One-chunk-per-subsection would make the TTS-friendly whole-guideline path the exception. The heading is still the first spoken line. |
| 2026-08-13 | PHASE-02 vector filter paths are per document type: decisions `callTypeFamily,outcome`; remediations `callTypeFamily,outcome,origin`; postmortems `callTypeFamily,origin`; runbooks `sectionTitle` only | Filtering `$vectorSearch` on an undeclared path is a query-time error. **PHASE-07 must not pass `callTypeFamily` to the runbooks fan-out leg.** |
| 2026-08-13 | PHASE-02 index script is written for `numDimensions = 1024` (`voyage-3-large`). Live on M0: `vs_decisions`, `vs_remediations`, `vs_runbooks` are READY/queryable at 1024; `vs_postmortems` cannot be created until Flex | Runbook `$vectorSearch` is unblocked. Do not start postmortem retrieval until the fourth index is READY. Do not take Plan B. |
| 2026-08-13 | Keep the four-collection contract. Do not take M0 Plan B. Atlas MCP could not confirm the tier because org AI access is disabled | Operator still needs a Flex (or dedicated) cluster. PHASE-01 recorded the MCP failure in agents.md rather than merging collections. |

## Open Items

- Tune `SIGNATURE_MATCH_FLOOR` (currently 0.62) once real seeded data exists. It must still return `null` for demo call one so the agent can honestly say "new signature, no prior history."
- Confirm the exact `@langchain/langgraph` 1.4.9 export names for `interrupt` and `Command` against the installed types.
- Decide whether the Twilio outbound upgrade is attempted, based on remaining time after PHASE-13's browser transport works end to end.
