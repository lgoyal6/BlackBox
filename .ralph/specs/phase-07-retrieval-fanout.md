# Phase 07 — Three-Collection Fan-Out Retrieval

**Status:** PENDING
**Tasks:** US-012, US-013
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 35 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Implement `RetrievalPort` as a single Atlas aggregation pipeline that fans out across `decisions`, `postmortems`, and `runbooks` with `$vectorSearch` and `$unionWith`, fuses the three ranked lists with reciprocal rank fusion, and exposes the three memory-specific queries the graph depends on: signature match, failure memory, and the reclassification prior.

## Why This Phase Is The MongoDB Story

"Three sources in one Atlas aggregation pipeline" is precisely what the MongoDB judges reward, and it is the one part of the architecture that cannot be faked in a slide. It must be **one** pipeline, not three `find` calls merged in JavaScript, and `--show-pipeline` must print it cleanly enough to put on screen.

The second thing this phase carries is `signatureMatch`. That node is what makes this a memory project rather than a runbook lookup, and it is on the never-cut list.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §6 — `Hit`, `SignatureMatch`, `ExcludedPath`, `ReclassPrior`, and the constants `SIGNATURE_MATCH_FLOOR`, `RRF_K`, `SOURCE_WEIGHTS`, `SPOKEN_WORD_CAP`. Do not redefine any of them.
- `.ralph/contracts.md` §2 — `FAN_OUT_COLLECTIONS` (index 0 is the base collection), `vectorIndexName()`, `VECTOR_PATH`.
- `.ralph/contracts.md` §5 — the document shapes you are projecting from.
- `.ralph/contracts.md` §9 — the `RetrievalPort` interface, verbatim, and the registry's fixed real path.
- `.ralph/contracts.md` §10 — `recall_memory` and `get_protocol` have a **400 ms** latency budget. That budget is why nothing in this phase calls an LLM.
- `.ralph/overview.md` — Critical Rule 8 (failures are first-class), the collection table, the vector index budget.
- `fixtures/hits.json` (PHASE-01) — 12 `Hit` objects across all three sources. Fusion and spoken-cap logic are verified against this file with no database at all.
- `src/lib/fakes/retrieval.ts` (PHASE-01) — the behaviour your real implementation replaces. Match its shape so PHASE-08 sees no difference.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `src/lib/retrieval/index.ts` | Default export satisfying `RetrievalPort` |
| `src/lib/retrieval/pipeline.ts` | Pure pipeline builders |
| `src/lib/retrieval/fuse.ts` | Rank assignment and reciprocal rank fusion |
| `src/lib/retrieval/spoken.ts` | `SPOKEN_WORD_CAP` truncation |
| `src/lib/retrieval/signature.ts` | `signatureMatch` |
| `src/lib/retrieval/failures.ts` | `failureMemory` |
| `src/lib/retrieval/priors.ts` | `reclassPrior` |
| `scripts/verify-retrieval.ts` | The diagnostic you run when retrieval "looks broken" |

`npm run verify:retrieval` already points at that script in `contracts.md` §12. Do not edit `package.json`.

### Ports consumed

| Port | Used for | Set this to build in isolation |
|---|---|---|
| `EmbeddingsPort` | Turning the query string into `queryVector` | `EMBEDDINGS_MODE=fake` |

That is the only port. With `EMBEDDINGS_MODE=fake` this phase needs no API key and no other phase's code. It does need Atlas for the end-to-end path, but the parts most likely to be wrong — stage order, `$meta` placement, rank assignment, RRF arithmetic, spoken truncation — are all pure functions verified against `fixtures/hits.json` with no cluster at all.

**With fake embeddings, relevance is meaningless.** Hash vectors return arbitrary nearest neighbours. Under fakes, assert only structure: the pipeline shape, non-empty results where documents exist, correct ranks, correct RRF ordering, spoken caps. The four fixed relevance probes in `verify-retrieval.ts` only mean anything with `EMBEDDINGS_MODE=real` against seeded data. Say which mode you ran in when you report results, or somebody will read a green run as proof of relevance.

### Port implemented

`RetrievalPort`, **default-exported from `src/lib/retrieval/index.ts`** — the registry's fixed real path `@/lib/retrieval` (`contracts.md` §9). The default export must be an object satisfying the interface exactly:

```ts
const retrieval: RetrievalPort = { fanOut, signatureMatch, failureMemory, reclassPrior };
export default retrieval;
```

Use `satisfies RetrievalPort` or an explicit annotation so a signature drift is a compile error rather than a runtime surprise in PHASE-08.

## Files to Create

### `src/lib/retrieval/pipeline.ts`

Pure builders. No I/O, no database handle, so they are testable with nothing running.

```ts
export interface ResolvedFanOutOptions {
  sources: RetrievalSource[];           // base is sources[0]
  kPerSource: number;                   // default 8
  limit: number;                        // default 12
  filters: Partial<Record<RetrievalSource, Document>>;
}

export function buildSourcePipeline(
  source: RetrievalSource,
  queryVector: number[],
  k: number,
  filter?: Document,
): Document[];

export function buildFanOutPipeline(
  queryVector: number[],
  opts: ResolvedFanOutOptions,
): Document[];
```

`buildSourcePipeline` returns exactly three stages, in this order:

```ts
[
  { $vectorSearch: {
      index: vectorIndexName(source),      // vs_decisions | vs_postmortems | vs_runbooks
      path: VECTOR_PATH,                   // "embedding"
      queryVector,
      numCandidates: k * 20,
      limit: k,
      ...(filter ? { filter } : {}),
  }},
  { $addFields: { source, score: { $meta: "vectorSearchScore" } } },
  { $project: { /* normalized shape, see the table below */ } },
]
```

`buildFanOutPipeline` composes them:

```ts
[
  ...buildSourcePipeline(sources[0], queryVector, kPerSource, filters[sources[0]]),
  ...sources.slice(1).map((coll) => ({
    $unionWith: { coll, pipeline: buildSourcePipeline(coll, queryVector, kPerSource, filters[coll]) },
  })),
  { $sort: { source: 1, score: -1 } },
]
```

Run it with `col(sources[0]).aggregate(pipeline)`.

#### Four constraints that will bite

1. **`$vectorSearch` must be the first stage of the pipeline it appears in** — including inside each `$unionWith` sub-pipeline. Atlas supports this; putting anything before it does not error clearly, it just fails.
2. **`{ $meta: "vectorSearchScore" }` must be captured immediately after its own `$vectorSearch`, inside the same sub-pipeline.** Reading it after the `$unionWith` returns nothing, silently. This is the single most likely way to spend twenty minutes on a pipeline that returns rows with `score: null`.
3. **`numCandidates` must be at least `limit`.** Use `20 × limit`. Too low silently degrades recall — you get results, they are just the wrong ones, which is worse than an error.
4. **Any path used in a vector `filter` must have been declared as a `filter` field in the index definition** (PHASE-02) or the query errors outright. If a `callTypeFamily` filter throws, that is the cause. Catch it once, log the index gap by name, retry without the filter while over-fetching `k × 3` and post-filtering in TypeScript, and note the required index change in `agents.md`. Post-filtering after a limited vector search loses recall, so this is a degradation, not a fix.

#### Normalize inside each sub-pipeline

Project every source into the same field names before the union. If the rows are heterogeneous, the mapping code has to branch on `source` afterwards and the pipeline you show on stage looks like three unrelated queries stapled together.

| Output field | `decisions` | `postmortems` | `runbooks` |
|---|---|---|---|
| `docId` | `{ $toString: "$_id" }` | same | same |
| `source` | literal `"decisions"` | `"postmortems"` | `"runbooks"` |
| `score` | `{ $meta: "vectorSearchScore" }` | same | same |
| `title` | `$actionChosen` | `$whatChanged` | `$sectionTitle` |
| `text` | `$embeddedText` | `$narrative` | `$text` |
| `displayId` | `$displayId` | `$displayId` | `null` |
| `meta` | `incidentId`, `rationale`, `outcome`, `protocolConflict` | `incidentId`, `origin`, `severityDelta`, `lessons` | `pageStart`, `pageEnd`, `sectionPath` |

`meta` is `Record<string, unknown>` in the contract, so build it with a `$project` sub-document per source.

#### The empty `decisions` collection is the normal state

`decisions` is empty for the entire build and stays empty until the demo (Critical Rule 5). The base stage of the pipeline therefore returns zero rows almost every time you run it. That must not throw, must not divide by zero in fusion, and must not stop the other two sources returning results. Test it explicitly — this is not an edge case, it is how the system runs for the next eight hours.

One real failure mode: if the `decisions` **collection itself** does not exist because PHASE-02 has not run, the aggregation errors on the missing index rather than returning zero rows. Catch that specific error once, log a single warning naming `vs_decisions`, and re-run with `decisions` dropped from the source list so the base becomes `postmortems`. That keeps PHASE-07 unblocked while PHASE-02 is still in flight, and the warning makes it impossible to ship without noticing.

### `src/lib/retrieval/fuse.ts`

```ts
export interface RawRow {
  docId: string;
  source: RetrievalSource;
  score: number;
  title: string;
  text: string;
  displayId: string | null;
  meta: Record<string, unknown>;
}

export function assignRanks(rows: RawRow[]): (RawRow & { rank: number })[];
export function fuse(rows: RawRow[], limit: number): Hit[];
```

**Fuse with reciprocal rank fusion, never by comparing raw scores across sources.** Cosine scores from three different corpora are not comparable. A 0.82 against clinical guideline prose and a 0.82 against a crew debrief mean different things, and sorting the union by raw score systematically favours whichever corpus has the tighter embedding distribution — in practice `runbooks`, because guideline prose is stylistically uniform. That would bury exactly the memory hits this project exists to surface, and it would do it quietly.

The arithmetic:

1. Group rows by `source`. Within each source, sort by `score` descending and assign `rank` starting at 1, breaking ties by `docId` ascending so repeated runs are byte-identical.
2. `rrf = SOURCE_WEIGHTS[source] / (RRF_K + rank)`. This is the standard RRF sum with a single term, because the three corpora are disjoint and a document appears in exactly one ranked list. Keep it written as a sum reduction if you like, but do not go looking for a second term.
3. Sort by `rrf` descending, then `score` descending, then `docId` ascending. Take `limit`.
4. **Keep the raw `score` on every `Hit`.** The dashboard displays similarity scores and judges look at them. `rank`, `rrf`, and `score` are all required fields on `Hit`.

`RRF_K` is 60 and `rank` starts at 1, so the denominator is never below 61 and there is no division by zero anywhere. Do not normalize by the maximum `rrf` — with an empty result set that is a divide-by-zero, and normalized fused scores are not more informative than the raw ones.

### `src/lib/retrieval/spoken.ts`

```ts
export function toSpoken(text: string, cap = SPOKEN_WORD_CAP): string;
```

Every `Hit` carries a `spoken` field capped at 40 words alongside the full `text`. This is not cosmetic. The agent reads hits aloud, and a 200-word guideline chunk at TTS pace is about ninety seconds of a medic listening to a robot while driving. That fails the ElevenLabs interaction-design criterion no matter how good the retrieval underneath it was.

Truncation rules:

- Split on whitespace, take at most `cap` words.
- If the text was truncated, cut back to the last sentence-ending punctuation inside the cap when one exists; otherwise end the last word with a period.
- **Never emit a trailing ellipsis.** TTS either reads it as a long dead pause or as nothing, and a mid-sentence cut sounds exactly like a dropped call.

### `src/lib/retrieval/index.ts`

```ts
export async function fanOut(
  query: string,
  opts?: { kPerSource?: number; limit?: number; callTypeFamily?: CallTypeFamily },
): Promise<Hit[]>;
```

The signature is fixed by the port; do not widen it. Internally, route through a private helper that takes an explicit source list, because `signatureMatch` and `failureMemory` need different source sets:

```ts
export async function fanOutFrom(
  query: string,
  sources: RetrievalSource[],
  opts?: { kPerSource?: number; limit?: number; callTypeFamily?: CallTypeFamily },
): Promise<Hit[]>;
```

`fanOut` calls `fanOutFrom(query, [...FAN_OUT_COLLECTIONS], opts)`. Defaults: `kPerSource` 8, `limit` 12.

Embed the query with `(await embeddings()).embedOne(query, "query")` — the `"query"` input type, not `"document"`. Voyage embeds the two asymmetrically and using the wrong one costs measurable recall for no reason.

### `src/lib/retrieval/signature.ts`

```ts
export async function signatureMatch(incident: IncidentDoc): Promise<SignatureMatch | null>;
export function buildSignatureQuery(incident: IncidentDoc): string;
```

Build the query from **what the crew actually knows at dispatch**, not from anything that would leak the answer:

- `labelFor(incident.cad.initialCallType)` — the expanded label, never the raw code.
- The initial severity level, phrased in words.
- `incident.cad.dispatchArea` and borough.
- Any `timeline` text so far, medic entries first, capped at roughly 300 characters so the dispatch signal is not drowned out by narration.

Search `decisions` and `postmortems` only. **Not `runbooks`** — a clinical guideline is not a signature. A guideline matching your query means the query mentioned a body system, which tells you nothing about whether this pattern has been seen before.

Never read `_groundTruth`, even if the caller hands you a document that has it attached. Agent-facing reads use `PUBLIC_INCIDENT_PROJECTION`.

**The floor is compared against the raw score, not the fused score.** Rank the union by `rrf`, take the top hit, and compare **`topHit.score`** to `SIGNATURE_MATCH_FLOOR` (0.62). RRF values live around `1.3 / 61 ≈ 0.021`, so comparing `rrf` to 0.62 returns `null` on every call and looks exactly like "retrieval found nothing." Write the comparison against `score` and put a one-line comment on it.

Return value when above the floor: `hits` (the fused list), `displayId` from the top hit, `confidence` set to the top hit's raw score so the dashboard has something honest to render, and `summary`.

`summary` is spoken, so cap it at **25 words** and write it as speech, not as a database record. Build it deterministically from a template — no LLM call, because `recall_memory` has a 400 ms budget and an LLM round trip alone exceeds it. Something in the shape of: "Similar to incident {displayId}: {whatChanged in plain words}. {first lesson, trimmed}."

**Returning `null` is a first-class result, not a failure.** On demo call one the agent says "new signature, no prior history" and means it. A matcher that always finds something is a lookup table with extra steps, and the contrast between call one returning `null` and call two returning a match is the entire demonstration. Tune `SIGNATURE_MATCH_FLOOR` **once**, against real seeded data from PHASE-06, and if you change it, change it in `contracts.md` and announce it.

### `src/lib/retrieval/failures.ts`

```ts
export async function failureMemory(query: string, family?: CallTypeFamily): Promise<Hit[]>;
```

Returns the known-bad paths that PHASE-08's `Plan` node excludes. Two sources:

- `remediations` filtered to `outcome: "failure"`
- `postmortems` filtered to `severityDelta > 0`

Same single-pipeline construction: base on `remediations` with its own `$vectorSearch` on `vs_remediations`, `$unionWith` for `postmortems`, fuse with RRF.

**Any code path here that filters to successes violates Critical Rule 8.** The failures are the product. There is a grep-based acceptance criterion for this.

#### Contract gap you must resolve before implementing

`RetrievalSource` in `contracts.md` §6 is `"decisions" | "postmortems" | "runbooks"`. It does not include `"remediations"`, but `failureMemory` returns `Hit[]` and queries `remediations`. There is no honest value for `Hit.source` on a remediation hit, and labelling it `"decisions"` puts a wrong source badge on the dashboard.

Do the contract change rather than the lie: add `"remediations"` to `RetrievalSource` and a weight to `SOURCE_WEIGHTS` (1.25 is a sensible value — between `decisions` at 1.3 and `postmortems` at 1.2 — but pick it deliberately). `SOURCE_WEIGHTS` is typed `Record<RetrievalSource, number>`, so omitting the weight is a compile error, which is a useful forcing function. Follow the project rule: edit `.ralph/contracts.md`, log it in `.ralph/agents.md` under Technical Decisions, then implement.

If you cannot touch `contracts.md` at that moment, the unblocking fallback is to return only postmortem-sourced failure hits and log one loud warning that remediation failures are suppressed pending the contract change. Do not ship the demo that way — the seeded remediations are where the pre-labelled failures live.

The filter paths `outcome` and `severityDelta` must be declared as `filter` fields in the PHASE-02 index definitions. If they are not, apply the same catch-and-post-filter degradation described in `pipeline.ts`, over-fetching `k × 3`.

### `src/lib/retrieval/priors.ts`

```ts
export async function reclassPrior(
  initialCallType: string,
  dispatchArea?: string,
): Promise<ReclassPrior | null>;
```

Serves the data file `data/reclass-priors.json` produced by PHASE-04. It powers the brief line visible in the design reference: "this call type in B3 reclassifies to cardiac 18% of the time overnight."

- Load lazily on first call and cache the parsed result in a module-level variable. This is read on the critical path to the first spoken word; re-reading a file per call is pointless latency.
- Expect an array of `ReclassPrior` (`contracts.md` §6). Index it into a `Map` keyed `` `${initialCallType}|${dispatchArea ?? "*"}` ``. Fall back to the area-agnostic entry when the specific area is missing.
- **Return `null` when the file is absent, unparseable, or has no matching entry. Never throw.** `data/` is in `.gitignore`, so on any fresh clone the file does not exist, and the brief must degrade to three sentences instead of four rather than taking down the graph on the way to the first spoken word.

### `scripts/verify-retrieval.ts`

This is what you run when retrieval "looks broken", so it has to be ordered by how expensive each failure is to misdiagnose.

**Step one, before any query: print every `vs_*` index and its status,** via `listSearchIndexes()` on each of the four vector collections. **Stop with a clear message and a non-zero exit if any index is not `READY`.** An index that is still building returns empty results and looks identical to a broken query, a wrong dimension, or an empty collection. This check has to come first or it will cost someone forty minutes of debugging a pipeline that was correct the whole time. Print the collection, index name, status, and `numDimensions`, and compare that last value against `env.embeddingDim` — a mismatch there is the other silent-empty-results failure.

**Step two: run four fixed probes.**

| Probe query | Expected dominant source |
|---|---|
| `"dispatched unconscious, found in cardiac arrest"` | `postmortems` |
| `"adult cardiac arrest compressions airway"` | `runbooks` |
| `"receiving facility on diversion, lost time rerouting"` | the curated postmortem from PHASE-06 |
| `"weakness and nausea in an older patient, no chest pain"` | the demo call 2 query |

For each probe, print the fused top 8 as a table: source, rank, raw score, RRF, title, and a short snippet. Assert that hits come from **at least 2 distinct sources** — that assertion is what proves the union is actually unioning rather than one sub-pipeline quietly returning nothing.

Flags:

| Flag | Effect |
|---|---|
| `--show-pipeline` | Dump the built pipeline as formatted JSON, for the stage |
| `--query="..."` | Run one ad-hoc probe instead of the four |
| `--limit=N` | Override the fused limit |

Under `EMBEDDINGS_MODE=fake`, skip the source-expectation assertions and print a banner saying relevance is not being checked. Keep the structural assertions — at least two distinct sources, ranks contiguous from 1 per source, every `spoken` at or under 40 words — since those hold regardless of embedding quality.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `src/lib/retrieval/index.ts` default-exports an object satisfying `RetrievalPort`, verified by a type-level annotation, and `RETRIEVAL_MODE=real` resolves to it through the registry with no `FAKE PORT` warning
- [ ] `buildFanOutPipeline` produces exactly one pipeline whose stage order is `$vectorSearch`, `$addFields`, `$project`, `$unionWith`, `$unionWith`, `$sort` — asserted programmatically on the stage keys, with no other database call involved
- [ ] Inside every `$unionWith` sub-pipeline, `$vectorSearch` is stage 0 and `{ $meta: "vectorSearchScore" }` is captured in stage 1
- [ ] `numCandidates` is at least `limit` for every generated stage, and equals `20 × k` at defaults
- [ ] **Parallel-safe criterion:** with `EMBEDDINGS_MODE=fake` and every other port faked, `fuse()` over `fixtures/hits.json` returns hits with contiguous per-source ranks starting at 1, correct `rrf = SOURCE_WEIGHTS[source] / (60 + rank)` values, and a descending `rrf` ordering — with no cluster connection at all
- [ ] With `decisions` empty (its normal state), `fanOut()` returns a non-empty result set drawn from the other two sources, throws nothing, and produces no `NaN` or `Infinity` in any `rrf`
- [ ] With all three collections empty, `fanOut()` returns `[]` rather than throwing
- [ ] Every returned `Hit` has a `spoken` field of 40 words or fewer, a non-empty `text`, and a numeric `score`, `rank`, and `rrf`
- [ ] No `spoken` value ends with an ellipsis character or an unterminated word
- [ ] `signatureMatch` returns `null` when the top fused hit's **raw** score is below `SIGNATURE_MATCH_FLOOR`, and a populated `SignatureMatch` when it is above — both branches exercised
- [ ] `signatureMatch` never queries `runbooks`: `rg -n "RUNBOOKS|runbooks" src/lib/retrieval/signature.ts` returns nothing
- [ ] `signatureMatch.summary` is 25 words or fewer, and the call completes without any LLM invocation (verified by running with `LLM_MODE=real` and no `OPENAI_API_KEY`)
- [ ] No file in `src/lib/retrieval/` references `_groundTruth`: `rg -n "_groundTruth" src/lib/retrieval` returns nothing
- [ ] No retrieval code path filters remediations to successes: `rg -n '"success"' src/lib/retrieval` returns nothing
- [ ] `reclassPrior` returns `null` — not a throw — when `data/reclass-priors.json` is absent, and a populated `ReclassPrior` when a matching entry exists
- [ ] `npm run verify:retrieval` exits non-zero with a message naming the offending index when any `vs_*` index is not `READY`, and that check runs before any query is issued
- [ ] `npm run verify:retrieval` with real embeddings against seeded data prints the fused top 8 per probe and asserts hits from at least 2 distinct sources on all four probes
- [ ] `npm run verify:retrieval -- --show-pipeline` prints valid JSON that round-trips through `JSON.parse`

## Verification

PowerShell users: set env vars with `$env:EMBEDDINGS_MODE='fake'` on a preceding line rather than the inline prefix shown here.

```bash
npm run typecheck

# Pure-function checks. No cluster, no keys, no other phase.
npx tsx -e "
import { buildFanOutPipeline } from './src/lib/retrieval/pipeline';
import { FAN_OUT_COLLECTIONS } from './src/lib/contracts';
const p = buildFanOutPipeline(new Array(1024).fill(0.01), {
  sources: [...FAN_OUT_COLLECTIONS], kPerSource: 8, limit: 12, filters: {},
});
console.log('outer stages', p.map(s => Object.keys(s)[0]).join(' -> '));
const sub = p.find(s => '\$unionWith' in s)['\$unionWith'].pipeline;
console.log('sub stages', sub.map(s => Object.keys(s)[0]).join(' -> '));
console.log('meta captured at stage 1:', JSON.stringify(sub[1]).includes('vectorSearchScore'));
console.log('numCandidates', sub[0]['\$vectorSearch'].numCandidates, 'limit', sub[0]['\$vectorSearch'].limit);
console.log(JSON.stringify(p, null, 2));
"

npx tsx -e "
import { readFileSync } from 'fs';
import { fuse } from './src/lib/retrieval/fuse';
import { RRF_K, SOURCE_WEIGHTS } from './src/lib/contracts';
const rows = JSON.parse(readFileSync('fixtures/hits.json','utf8'));
const hits = fuse(rows, 12);
console.table(hits.map(h => ({ source: h.source, rank: h.rank, score: h.score, rrf: +h.rrf.toFixed(5) })));
const ok = hits.every(h => Math.abs(h.rrf - SOURCE_WEIGHTS[h.source] / (RRF_K + h.rank)) < 1e-9);
const sorted = hits.every((h,i) => i === 0 || hits[i-1].rrf >= h.rrf);
const spoken = hits.every(h => h.spoken.trim().split(/\s+/).length <= 40);
console.log('rrf correct', ok, 'sorted', sorted, 'spoken capped', spoken);
process.exit(ok && sorted && spoken ? 0 : 1);
"

# Empty-decisions behaviour, which is the system's normal state all day.
EMBEDDINGS_MODE=fake npx tsx -e "
import r from './src/lib/retrieval/index';
import { col } from './src/lib/db/client';
import { DECISIONS } from './src/lib/contracts';
console.log('decisions count', await col(DECISIONS).countDocuments({}));
const hits = await r.fanOut('unconscious male found pulseless');
console.log('hits', hits.length, 'sources', [...new Set(hits.map(h => h.source))].join(','));
console.log('finite rrf', hits.every(h => Number.isFinite(h.rrf)));
process.exit(0);
"

# The real diagnostic. Index status first, then the four probes.
npm run verify:retrieval
npm run verify:retrieval -- --show-pipeline
npm run verify:retrieval -- --query="weakness and nausea in an older patient, no chest pain"

# Rule checks.
rg -n "_groundTruth" src/lib/retrieval; rg -n '"success"' src/lib/retrieval
rg -n "runbooks|RUNBOOKS" src/lib/retrieval/signature.ts
```

## Handoff Note

Announce the tuned value of `SIGNATURE_MATCH_FLOOR` and the observed raw-score range for real matches against the seeded corpus. PHASE-08's `brief` node behaves completely differently on either side of that number, and PHASE-15 scripts the words "new signature, no prior history" around it.
