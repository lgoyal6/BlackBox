# Phase 02 — Collections, Validators, and Vector Indexes

**Status:** CODE COMPLETE — live Atlas run blocked on MONGODB_URI
**Tasks:** US-004, US-005
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 25 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Create every collection this project writes to, the standard indexes that keep its queries cheap, a server-side validator that turns "every decision carries a reason" into a database-level guarantee, and the four Atlas Vector Search indexes that retrieval depends on. Then block until Atlas reports all four indexes `READY`, because a vector query issued against a still-building index returns an empty array that is indistinguishable from a broken query.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §2 — collection names, `vectorIndexName()`, `VECTOR_PATH`. Import these; never retype a collection name as a string literal.
- `.ralph/contracts.md` §5 — the document types. Every vector filter path declared here must be a real field on that document type, so read the interfaces before choosing filter paths.
- `.ralph/contracts.md` §8 — the `events` shape and the 24-hour TTL requirement.
- `.ralph/contracts.md` §13 — the dimension rule: `EMBEDDING_DIM` must equal every vector index's `numDimensions`.
- `.ralph/overview.md` — "Atlas Vector Index Budget" (the M0 three-index cap and the Plan B), the collections table, and Critical Rules 4 and 8.
- `src/lib/db/client.ts` — `getDb()` and `col()`. Do not construct a second `MongoClient`.
- `src/lib/env.ts` — `env.embeddingDim` and `assertEmbeddingConfig()`.
- `.ralph/specs/phase-01-contracts-and-scaffold.md` — `scripts/check-atlas.ts` already proves the cluster supports search indexes and change streams. Do not duplicate those checks here; assume they passed and fail loudly if `listSearchIndexes()` throws.

## Parallel-Safe Contract

### Files this phase owns

Exactly three, from the ownership table in `overview.md`:

- `src/lib/db/indexes.ts`
- `src/lib/db/validators.ts`
- `scripts/create-indexes.ts`

Do not create or edit anything else. In particular: `package.json` already contains `"indexes": "tsx scripts/create-indexes.ts"` from PHASE-01, so no script registration is needed, and `src/lib/db/client.ts` belongs to PHASE-01.

### Ports consumed

None at runtime. This phase talks only to `@/lib/db/client` and `@/lib/env`.

That said, run every command in this spec with all port modes forced to `fake`:

```
EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake MEMORY_MODE=fake LLM_MODE=fake EVENTS_MODE=fake GRAPH_MODE=fake VOICE_MODE=fake
```

`EMBEDDINGS_MODE=fake` matters for the smoke test in Verification. The fake embeddings provider returns a deterministic unit vector of exactly `env.embeddingDim` floats with zero network calls, which is precisely what a `$vectorSearch` needs to prove an index is live. That means this phase's most important acceptance criterion — a real vector query returning a real hit — is verifiable before PHASE-03 exists.

What this phase does need is a live Atlas cluster at Flex tier or higher. Mongo cannot be faked, and the M0 three-index cap will surface here as a hard failure on the fourth `createSearchIndex` call. If that happens, PHASE-01's cluster check was skipped; stop and fix the cluster rather than taking the Plan B unilaterally, because thirteen other agents are already coding against the four-collection contract.

### Ports implemented

None. This phase default-exports nothing and is never resolved through `src/lib/registry.ts`. Other phases reach its work through Mongo itself — the indexes are the deliverable, not a module.

## Files to Create

### `src/lib/db/validators.ts`

The server-side JSON Schema validator for `decisions`, plus the function that applies it.

```ts
import type { Document } from "mongodb";

/** $jsonSchema validator enforcing Critical Rule 4 at the database level. */
export const DECISIONS_VALIDATOR: Document;

export interface ValidatorReport {
  collection: string;
  action: "created" | "collmod" | "unchanged";
}

/** Creates the collection with its validator, or applies it via collMod if it exists. */
export async function applyValidators(): Promise<ValidatorReport[]>;
```

The schema requires four fields and constrains the two that matter:

| Field | `bsonType` | Constraint | Why |
|---|---|---|---|
| `incidentId` | `string` | `minLength: 1` | Every decision must be attributable to a call. |
| `actionChosen` | `string` | `minLength: 1` | A decision with no action is not a decision. |
| `rationale` | `string` | `minLength: 1` | Critical Rule 4. This is the field the whole project exists to capture. |
| `t` | `date` | — | Guards against an ISO string being stored in a date field, which `contracts.md` §13 forbids and which silently breaks the `decisions_incidentId_t` sort. |

Set `validationAction: "error"` and `validationLevel: "strict"`. `error` means a bad write is rejected rather than logged, which is the entire point: when a judge asks whether the rationale requirement is real, the answer is a failed insert, not a code comment. `strict` is safe here because `decisions` is insert-only and starts empty — there is no legacy data that `moderate` would need to tolerate.

**Do not set `additionalProperties: false`.** The document also carries `embedding`, `embeddedText`, `optionsConsidered`, `outcome`, `protocolConflict`, `callTypeFamily`, and `displayId`, and PHASE-09 or PHASE-13 may add a field under a deadline. A closed schema converts every such addition into a rejected write during the live demo, which is the most expensive possible time to discover it. Require what must be present; permit everything else.

Two implementation notes that will otherwise cost ten minutes:

1. `db.createCollection()` throws `NamespaceExists` (code 48) when the collection is already there, and `db.command({ collMod })` throws `NamespaceNotFound` (code 26) when it is not. Call `db.listCollections({}, { nameOnly: true })` once, then branch. Do not drive control flow off caught errors.
2. Only `decisions` gets a validator. `runbooks` and `postmortems` deliberately get none, because a validator's failure mode is a rejected write and only `decisions` has a rule worth that risk. Say no to the temptation to validate everything.

### `src/lib/db/indexes.ts`

Everything else: collection creation, standard indexes, the four vector search indexes, and the readiness wait.

```ts
export interface CollectionReport { name: string; created: boolean }
export interface StandardIndexReport { collection: string; name: string; created: boolean }

export interface VectorFilterField { type: "filter"; path: string }
export interface VectorField {
  type: "vector";
  path: string;
  numDimensions: number;
  similarity: "cosine";
}
export interface VectorIndexSpec {
  collection: string;
  name: string;                       // vectorIndexName(collection)
  type: "vectorSearch";
  definition: { fields: (VectorField | VectorFilterField)[] };
}

export type VectorIndexState = "PENDING" | "BUILDING" | "READY" | "FAILED" | "STALE" | "DELETING" | "UNKNOWN";
export interface VectorIndexStatus {
  collection: string;
  name: string;
  status: VectorIndexState;
  queryable: boolean;
  numDimensions: number | null;       // read back from latestDefinition
}

/** The 8 collections this phase creates. Does NOT include checkpoints/checkpoint_writes. */
export const MANAGED_COLLECTIONS: readonly string[];

export async function ensureCollections(): Promise<CollectionReport[]>;
export async function ensureStandardIndexes(): Promise<StandardIndexReport[]>;

/** Pure function — no I/O. Unit-testable without a cluster. */
export function vectorIndexSpec(collection: string): VectorIndexSpec;
export function vectorIndexSpecs(): VectorIndexSpec[];

/** Skips indexes that already exist and match; drops and recreates ones whose numDimensions is wrong. */
export async function ensureVectorIndexes(): Promise<{ spec: VectorIndexSpec; action: "created" | "recreated" | "unchanged" }[]>;

export async function listVectorIndexStatus(): Promise<VectorIndexStatus[]>;

export async function waitForVectorIndexes(opts?: {
  timeoutMs?: number;                 // default 240_000
  pollMs?: number;                    // default 3_000
  onPoll?: (elapsedMs: number, statuses: VectorIndexStatus[]) => void;
}): Promise<VectorIndexStatus[]>;
```

#### Collections to create

Eight, all from `contracts.md` §2 — the six real ones plus two internal:

| Collection | Constant | Purpose |
|---|---|---|
| `incidents` | `INCIDENTS` | One document per call. |
| `decisions` | `DECISIONS` | The black box. Gets the validator. Stays empty until the demo. |
| `remediations` | `REMEDIATIONS` | Actions and their outcomes, failures included. |
| `runbooks` | `RUNBOOKS` | NASEMSO chunks from PHASE-05. |
| `postmortems` | `POSTMORTEMS` | Generated at call close. |
| `events` | `EVENTS` | The event bus. TTL'd. |
| `_embed_cache` | `EMBED_CACHE` | PHASE-03's embedding cache. |
| `_watch_state` | `WATCH_STATE` | PHASE-12's change stream resume tokens. No index — documents are keyed by `_id`, and PHASE-12 owns the shape. |

**`checkpoints` and `checkpoint_writes` are deliberately absent.** LangGraph's `MongoDBSaver` creates and indexes them on first use, and a hand-rolled index on a saver-managed collection is a conflict waiting to happen at exactly the wrong moment. Print a line saying they are managed by the saver so nobody adds them later thinking it was an oversight.

Creating collections explicitly (rather than letting the first insert do it) matters for one concrete reason: `createSearchIndex` fails on a namespace that does not exist yet, and this phase runs before any phase has written a document.

#### Standard indexes

| Collection | Key | Options | Name | Why it exists |
|---|---|---|---|---|
| `incidents` | `{ incidentId: 1 }` | `unique: true` | `incidents_incidentId_uq` | Every join, every `thread_id`, and PHASE-04's upsert key. |
| `incidents` | `{ status: 1 }` | — | `incidents_status` | The worker and dashboard filter on it. |
| `incidents` | `{ isLive: 1 }` | — | `incidents_isLive` | `/api/demo/reset` deletes exactly `isLive: true`. |
| `decisions` | `{ incidentId: 1, t: -1 }` | — | `decisions_incidentId_t` | Timeline reads want newest first. |
| `remediations` | `{ incidentId: 1, outcome: 1 }` | — | `remediations_incidentId_outcome` | Failure memory queries by outcome. |
| `postmortems` | `{ incidentId: 1, origin: 1 }` | — | `postmortems_incidentId_origin` | `/api/demo/reset` deletes `origin: "live"` and must leave seeded ones alone. |
| `runbooks` | `{ sectionTitle: 1 }` | — | `runbooks_sectionTitle` | Title lookup and duplicate detection during PHASE-05 iteration. |
| `_embed_cache` | `{ hash: 1 }` | `unique: true` | `embed_cache_hash_uq` | The cache lookup is a single `find({ hash: { $in: [...] } })`. |
| `events` | `{ incidentId: 1, seq: 1 }` | — | `events_incidentId_seq` | SSE replay must come back in order. |
| `events` | `{ t: 1 }` | `expireAfterSeconds: 86400` | `events_ttl_t` | Rehearsal runs self-clean, so the third run of the demo is not reading the first run's events. |

Always pass an explicit `name`. `createIndex` is idempotent when the key and options match, so re-running the script is free; but if the TTL already exists with a different `expireAfterSeconds`, Mongo throws `IndexOptionsConflict` (code 85). Handle that one case by adjusting in place rather than dropping:

```ts
await db.command({ collMod: EVENTS, index: { name: "events_ttl_t", expireAfterSeconds: 86400 } });
```

One line of documentation to save a future debugging session: mongod's TTL monitor sweeps once every 60 seconds, so an expired event can survive up to a minute past its 24 hours. That is harmless here, and knowing it prevents someone from concluding the TTL index is broken.

#### Vector search indexes

Four, created with the Node driver's `createSearchIndex` and `type: "vectorSearch"`. Names come from `vectorIndexName(collection)`, so they are `vs_decisions`, `vs_remediations`, `vs_runbooks`, `vs_postmortems`.

The vector field is identical across all four:

```ts
{ type: "vector", path: VECTOR_PATH, numDimensions: env.embeddingDim, similarity: "cosine" }
```

The filter fields differ, and they differ because the documents differ:

| Collection | Index | Filter paths | Why exactly these |
|---|---|---|---|
| `decisions` | `vs_decisions` | `callTypeFamily`, `outcome` | Fan-out narrows by family; `outcome` lets retrieval separate what worked from what did not. |
| `remediations` | `vs_remediations` | `callTypeFamily`, `outcome`, `origin` | `RetrievalPort.failureMemory` filters `outcome: "failure"`; `origin` separates seeded corpus from live writes. |
| `postmortems` | `vs_postmortems` | `callTypeFamily`, `origin` | Same reasoning. `PostmortemDoc` has no `outcome` field. |
| `runbooks` | `vs_runbooks` | `sectionTitle` | `RunbookDoc` has neither `callTypeFamily` nor `origin`. |

**Declare only filter paths that exist on that collection's document type.** Filtering a `$vectorSearch` on a path that was not declared in the index definition is a query-time error, and declaring a path that no document carries produces an index that can never usefully filter on it. Check each path against the interface in `contracts.md` §5 before writing it down.

That last row has a cross-phase consequence worth stating here, because this is the file that encodes it: **PHASE-07 must not pass a `callTypeFamily` filter to the `runbooks` leg of the fan-out.** `RetrievalPort.fanOut` accepts a `callTypeFamily` option, and it applies to the `decisions` and `postmortems` legs only. Note this in `agents.md` when you finish, since it is a constraint PHASE-07 cannot discover from `contracts.md` alone.

#### The dimension assertion

Call `assertEmbeddingConfig()` first, then print the resolved dimension on its own line before creating anything:

```
numDimensions = 1024   (EMBEDDING_MODEL=voyage-3-large, EMBEDDING_DIM=1024)
```

A `numDimensions` that disagrees with the vectors being written returns zero results with no error, no warning, and no log line. It looks exactly like a retrieval bug, and people have spent hours in PHASE-07 chasing it. Printing the number makes the mismatch visible in five seconds instead.

This is also why `ensureVectorIndexes` reads back `latestDefinition` from `listSearchIndexes()` and compares `numDimensions` to `env.embeddingDim`. When they differ, drop the index with `dropSearchIndex(name)` and recreate it, and print `recreated vs_x: numDimensions 1536 -> 1024`. Skipping a mismatched index because "it already exists" preserves the single worst state this project can be in.

#### Waiting for READY

Poll `listSearchIndexes()` every 3 seconds until every `vs_*` index reports `status` of `READY` (compare case-insensitively) and `queryable: true`. Print a progress line per poll so the wait does not look like a hang:

```
  18s  vs_decisions BUILDING  vs_remediations BUILDING  vs_runbooks READY  vs_postmortems BUILDING
```

Abort immediately with a non-zero exit if any index reports `FAILED`, including whatever error text Atlas attaches. Time out at 240 seconds — the four builds run concurrently and each takes 30 to 90 seconds, so a normal run finishes well inside two minutes, and anything past four minutes is a real problem rather than slowness.

**This wait is not optional and must not be shortened.** A `$vectorSearch` against a `BUILDING` index returns `[]`. No error, no warning. Every phase downstream of this one will read that empty array as "my query is wrong" and start editing a pipeline that was already correct. This is the single most common false alarm in a build like this one, and thirty extra seconds here prevents it.

Cost note: the wait is the only slow part of this phase, roughly two minutes on the first run. Re-runs skip existing indexes and finish in a few seconds, so run this script early and once. There is no cheaper alternative — Atlas builds take as long as they take — but you can start PHASE-03, 04, and 05 while it runs, since none of them need a READY index to be written and verified.

### `scripts/create-indexes.ts`

The orchestrator behind `npm run indexes`. Sequential, because the order is a real dependency chain, and each step prints its own report:

1. `assertEmbeddingConfig()`, then print the resolved `numDimensions`.
2. `ensureCollections()` — print created versus already-present, and the note about `checkpoints` being saver-managed.
3. `applyValidators()` — print which action was taken on `decisions`.
4. `ensureStandardIndexes()` — print one line per index.
5. `ensureVectorIndexes()` — print `created` / `recreated` / `unchanged` per index.
6. `waitForVectorIndexes()` — progress lines, then a final table.
7. Print a one-line summary and `process.exit(0)`, or the failure and `process.exit(1)`.

Support two flags:

- `--skip-wait` — do steps 1 through 5 and exit. Useful only when you already know the indexes are READY and want to re-check the standard indexes quickly. Print a loud warning that vector queries may return empty until the build completes, so the flag cannot be the source of a mystery.
- `--drop-vector` — drop all four `vs_*` indexes before creating them. The recovery path when `EMBEDDING_DIM` changes, for example after switching from Voyage to OpenAI.

Close the Mongo client in a `finally` block. A `tsx` script that leaves an open connection pool hangs instead of exiting, and someone will assume the index build is still going.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run indexes` exits 0 against a live Flex-or-higher cluster and prints the resolved `numDimensions` on its own line
- [ ] All 8 collections in `MANAGED_COLLECTIONS` exist after the run; `checkpoints` and `checkpoint_writes` are not created by this phase
- [ ] All 10 standard indexes from the table exist with the exact names given, verified by `listIndexes()` on each collection
- [ ] `events` has a TTL index on `t` with `expireAfterSeconds` exactly `86400`
- [ ] All 4 `vs_*` vector indexes exist, and every one reports `status: "READY"` and `queryable: true` when the script exits
- [ ] Every `vs_*` index's `latestDefinition` shows `numDimensions` equal to `env.embeddingDim`, `similarity: "cosine"`, and `path: "embedding"`
- [ ] Each `vs_*` index declares exactly the filter paths in the table above and no others
- [ ] Inserting a `decisions` document with `rationale: ""` is rejected by the server with a document-validation error; the same document with a non-empty `rationale` inserts successfully
- [ ] Inserting a `decisions` document with `t` as an ISO string rather than a `Date` is rejected
- [ ] **Verifiable with all other ports faked:** with `EMBEDDINGS_MODE=fake`, inserting one scratch document into `remediations` whose `embedding` comes from the fake embeddings port and then running a `$vectorSearch` on `vs_remediations` returns that document with a score above 0.9; the scratch document is deleted afterward
- [ ] Running `npm run indexes` a second time changes nothing, reports every index as unchanged, and completes in under 15 seconds
- [ ] With `EMBEDDING_DIM` deliberately set to a wrong value, the run reports `recreated` for all four indexes rather than silently leaving a mismatch
- [ ] The script exits non-zero if any index reports `FAILED`, and non-zero if the 240-second timeout elapses
- [ ] `npm run check` (PHASE-01) still passes after this phase runs

## Verification

On PowerShell, set inline environment variables with `$env:EMBEDDINGS_MODE="fake"` before the command instead of the `VAR=value cmd` prefix shown here.

```bash
npm run typecheck

# Full run. First execution takes ~2 minutes, almost all of it waiting on Atlas.
EMBEDDINGS_MODE=fake npm run indexes

# Idempotency: second run must be fast and report no changes.
EMBEDDINGS_MODE=fake npm run indexes
```

Confirm every vector index is READY with the right dimension:

```bash
npx tsx -e "
import { getDb, col } from './src/lib/db/client';
import { VECTOR_COLLECTIONS, vectorIndexName } from './src/lib/contracts';
import { env } from './src/lib/env';
for (const c of VECTOR_COLLECTIONS) {
  const idx = await col(c).listSearchIndexes().toArray();
  for (const i of idx) {
    const f = (i.latestDefinition?.fields ?? []).find((x:any)=>x.type==='vector');
    console.log(c, i.name, i.status, 'queryable=' + i.queryable,
                'dims=' + f?.numDimensions, 'expected=' + env.embeddingDim,
                'filters=' + (i.latestDefinition?.fields ?? []).filter((x:any)=>x.type==='filter').map((x:any)=>x.path).join(','));
  }
}
process.exit(0);
"
```

Prove the validator is a real server-side guarantee:

```bash
npx tsx -e "
import { col } from './src/lib/db/client';
import { DECISIONS } from './src/lib/contracts';
const base = { incidentId: 'validator-test', displayId: '0000', utterance: 'x',
  actionChosen: 'deferred airway', optionsConsidered: [], outcome: 'pending',
  protocolConflict: false, callTypeFamily: 'cardiac', embedding: [], embeddedText: 'x', t: new Date() };
try { await col(DECISIONS).insertOne({ ...base, rationale: '' } as any); console.log('FAIL: empty rationale accepted'); }
catch (e:any) { console.log('PASS: empty rationale rejected -', e.code ?? e.codeName); }
try { await col(DECISIONS).insertOne({ ...base, rationale: 'ok', t: new Date().toISOString() } as any); console.log('FAIL: string date accepted'); }
catch (e:any) { console.log('PASS: string t rejected -', e.code ?? e.codeName); }
const r = await col(DECISIONS).insertOne({ ...base, rationale: 'family reports recent neck surgery' } as any);
console.log('PASS: valid decision inserted', r.insertedId);
await col(DECISIONS).deleteMany({ incidentId: 'validator-test' });
process.exit(0);
"
```

End-to-end vector query with fake embeddings, which is the criterion that proves the index actually serves queries and not just that Atlas accepted a definition:

```bash
EMBEDDINGS_MODE=fake npx tsx -e "
import { col } from './src/lib/db/client';
import { REMEDIATIONS, vectorIndexName, VECTOR_PATH } from './src/lib/contracts';
import { embeddings } from './src/lib/registry';
const em = await embeddings();
const text = 'attempted supraglottic airway, aborted after two failed passes';
const v = await em.embedOne(text, 'document');
await col(REMEDIATIONS).insertOne({ incidentId: 'index-smoke', action: 'supraglottic airway',
  outcome: 'failure', durationSeconds: 90, costMinutes: 2, sideEffects: [], origin: 'seeded',
  callTypeFamily: 'cardiac', embedding: v, embeddedText: text, t: new Date() } as any);
const hits = await col(REMEDIATIONS).aggregate([
  { \$vectorSearch: { index: vectorIndexName(REMEDIATIONS), path: VECTOR_PATH,
      queryVector: v, numCandidates: 50, limit: 5, filter: { outcome: 'failure' } } },
  { \$project: { _id: 0, action: 1, score: { \$meta: 'vectorSearchScore' } } },
]).toArray();
console.log('hits', JSON.stringify(hits));
console.log(hits.length > 0 && hits[0].score > 0.9 ? 'PASS' : 'FAIL: index not serving queries');
await col(REMEDIATIONS).deleteMany({ incidentId: 'index-smoke' });
process.exit(0);
"
```

If that last command prints an empty `hits` array, check the index status before touching the pipeline. An empty result here means `BUILDING`, not a bad query, roughly nine times out of ten.

## Handoff Note

Announce two things when this phase finishes: that all four `vs_*` indexes are `READY`, and the exact `numDimensions` they were built with. PHASE-03, 05, 06, and 07 all need to write vectors of exactly that length, and the number is cheaper to broadcast than to rediscover.
