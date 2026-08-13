# Phase 01 — Contracts, Scaffold, Ports, and Fakes

**Status:** PENDING
**Tasks:** US-001, US-002, US-003
**Depends on:** nothing
**Blocks:** every other phase
**Budget:** 30 min
**Parallel:** no — this is the single prerequisite. Do not start any other phase until `npm run typecheck` passes here.

## Objective

Turn `.ralph/contracts.md` into compiling TypeScript, ship a deterministic fake for every port, ship the fixtures every other phase tests against, and prove the Atlas cluster can do what this project needs. When this phase is done, fourteen agents can work simultaneously without reading each other's code.

## Do This First (5 minutes, before writing any code)

**Confirm the cluster tier.** M0 free clusters cap at 3 Atlas Search indexes; this project needs 4. Discovering that at hour six is fatal.

The MongoDB MCP server is configured in this environment. Use `atlas-list-projects`, then `atlas-list-clusters`, then `atlas-inspect-cluster`.

If the cluster is `M0`, provision a **Flex** cluster before continuing. If that is impossible, take the Plan B in `overview.md` (merge `decisions` + `remediations` + `postmortems` into one `memory` collection with a `kind` discriminator), and **record the deviation in both `.ralph/contracts.md` and `.ralph/agents.md`** — other phases are about to code against the four-collection contract.

## Reference Files (read before implementing)

- `.ralph/contracts.md` — **implement this literally.** Every type, name, and constant.
- `.ralph/overview.md` — Parallel Execution Model, file ownership table, env vars
- `reference.png` — not needed here, but confirms the header fields `ref` / `label` / `dispatchArea` / `unit` in the `status` event

## Files to Create

### Scaffold

Initialize a Next.js 16.3 App Router project with TypeScript and Tailwind. Use the versions in `overview.md`; they are all verified available.

`package.json` must contain **every** script in `contracts.md` §12, including the ones whose target files do not exist yet. A phase that has to edit `package.json` to add its own script is a merge conflict waiting to happen.

`tsconfig.json`: `strict: true`, path alias `@/*` → `src/*`.

`next.config.ts`:

```ts
const nextConfig: NextConfig = {
  serverExternalPackages: ["mongodb", "unpdf", "@langchain/langgraph-checkpoint-mongodb"],
};
```

Without `serverExternalPackages`, the bundler tries to trace the Mongo driver's optional native dependencies and the build fails with confusing module-not-found errors for packages nobody installed.

`.env.example`: every key from `overview.md` → Environment Variables, secrets empty, port modes defaulting to `real`.

`.gitignore`: `.env*.local`, `.env`, `data/`, `node_modules/`, `.next/`, `*.pdf`.

`README.md`: name, one-line pitch, the 15.0% number, setup in five commands, and the script run order.

### `src/lib/env.ts`

Central env access with fail-fast validation. **Nothing else in the codebase reads `process.env` directly** except `registry.ts` for mode switches.

```ts
export const env = { mongodbUri, mongodbDb, embeddingProvider, embeddingModel,
                     embeddingDim, /* ... */ } as const;
export function assertEmbeddingConfig(): void;
```

`assertEmbeddingConfig()` enforces the model↔dimension pairing, because a mismatch between `EMBEDDING_DIM` and a vector index's `numDimensions` produces **empty search results with no error** — the single most expensive failure mode in this build:

| Model | Required `EMBEDDING_DIM` |
|---|---|
| `voyage-3-large` | 1024 |
| `voyage-3.5` | 1024 |
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |

Throw on any other combination rather than guessing.

### `src/lib/contracts/`

`collections.ts`, `domain.ts`, `events.ts`, `api.ts`, `ids.ts`, `index.ts` — a direct transcription of `contracts.md` §2–§8 and §10.

`api.ts` additionally carries the **Zod v4 schemas** for every route body, and exports the inferred types:

```ts
export const RecallMemoryReq = z.object({ incidentId: z.string(), query: z.string().min(1) });
export type RecallMemoryReq = z.output<typeof RecallMemoryReq>;
// ...one pair per route in contracts.md §10
```

Zod v4 changed the error API and issue shapes from v3. Do not copy v3 patterns from memory; check the installed version's types if anything fails to compile.

`ids.ts` implements `toDisplayId` and `toRef`. `toDisplayId` strips non-digits, takes the last 4, left-pads with `0`.

`domain.ts` implements `callTypeFamily()` and `labelFor()`. **`labelFor` must never return the bare code** — fall back to lowercasing and humanizing, because whatever it returns gets spoken aloud.

### `src/lib/ports.ts`

The six interfaces from `contracts.md` §9, verbatim. Interfaces only — no implementations, no imports of any implementation. Every phase imports its port type from here.

### `src/lib/registry.ts`

```ts
export async function embeddings(): Promise<EmbeddingsPort>;
export async function retrieval(): Promise<RetrievalPort>;
export async function llm(): Promise<LlmPort>;
export async function events(): Promise<EventsPort>;
export async function graph(): Promise<GraphPort>;
export async function voice(): Promise<VoicePort>;
```

Each reads its `*_MODE` env var and dynamically imports either `@/lib/fakes/<name>` or the fixed real path, then caches the resolved instance.

**Two rules that make parallelism work, and this file is where they are enforced:**

1. Import paths are **static string literals** in the dynamic `import()`. No path building, no variables. The real module for every port lives at a path fixed by the contract, so adding a real implementation never requires editing this file.
2. When a real module is missing (because that phase is not written yet), **fall back to the fake and log a single clear warning** rather than throwing. This is what lets PHASE-08 run before PHASE-07 exists. Log it loudly enough that nobody ships a demo silently running on fakes — include the words `FAKE PORT` in the message.

### `src/lib/db/client.ts`

```ts
export function getClient(): MongoClient;   // cached singleton
export function getDb(): Db;
export function col<T extends Document>(name: string): Collection<T>;
export async function ping(): Promise<{ ok: number; version: string; replicaSet: string | null }>;
```

Construct with `appName: "blackbox"` so writes are identifiable in the Atlas metrics UI — the demo shows that dashboard.

**Cache the client on `globalThis` in development.** Next.js hot-reload re-evaluates modules on every edit, and a module-level `let` creates a new connection pool each time until Atlas refuses new connections. This will happen around the fifth edit and the error message will not mention hot reload.

```ts
const g = globalThis as unknown as { __bbClient?: MongoClient };
```

### `src/lib/llm.ts`

The real `LlmPort`, owned here because five phases need it and none should own it. Thin wrapper over `openai` with `LLM_MODEL`, a 20-second timeout, two retries on 429/5xx, and structured JSON output for `json()`. Default-export an object satisfying `LlmPort`.

### `src/lib/fakes/`

One file per port. **Deterministic, zero network, zero database.** These are what every other phase tests against, so treat them as production code.

- `embeddings.ts` — `sha256(text)` seeds a PRNG producing a unit vector of `env.embeddingDim`. Same text → identical vector; different texts → near-orthogonal. This is what lets PHASE-04, 05, and 06 be built and verified with no embedding API key at all.
- `retrieval.ts` — reads `fixtures/hits.json`, filters by case-insensitive substring overlap with the query, computes real RRF over the filtered set so the shape is honest. `signatureMatch` returns `null` when the query contains `"transfer"` and a populated match otherwise, so both branches are testable.
- `llm.ts` — templated strings keyed on a prompt prefix. `json()` returns a fixed object matching the requested schema.
- `events.ts` — pushes to a module-level array; exports `__drain()` for assertions.
- `graph.ts` — walks `GRAPH_NODE_ORDER`, returning a `readback` interrupt at `readback_gate` on the first pass and `null` after resume.
- `voice.ts` — logs what it would speak.

### `fixtures/`

Six JSON files per `contracts.md` §11 (PHASE-06 owns `curated-postmortems.json`; do not create it).

Two deserve care because other phases are graded against them:

**`fixtures/event-stream.json`** must reproduce the **exact state shown in `reference.png`**: incident `260813-0442`, cardiac arrest, dispatch area B3, unit 14B, four voice turns at clocks `42:19`/`43:02`/`44:10`/`44:31`, one decision event (airway deferred, rationale recorded, no protocol conflict), one `readback` event in state `awaiting`, one `retrieval` event with three hits scoring 0.91/0.87/0.84, write counters at decisions 7 / timeline 34, active node `readback_gate`, checkpoint count 34. PHASE-14 builds the entire dashboard against this file with no backend running.

**`fixtures/incidents.json`** must include `_groundTruth` on the historical ones so PHASE-04 and PHASE-06 can test the answer-stripping and seeding logic without network access.

### `scripts/check-atlas.ts`

Preflight. Prints a report, exits non-zero on any failure. Checks in order:

1. `env` loads and `assertEmbeddingConfig()` passes
2. `ping()` succeeds; print server version
3. `hello` includes a replica set name → change streams supported
4. `listSearchIndexes()` is callable → Atlas Search available on this tier
5. Count existing search indexes; **warn loudly if fewer than 4 vector indexes can exist**
6. Round-trip write/read/delete on a scratch collection → credentials have write access
7. Print which ports would resolve to fakes under the current env

Step 7 matters more than it looks: at hour seven somebody will demo something that silently ran on fakes, and one line of output prevents it.

## Acceptance Criteria

- [ ] `npm install` completes with the versions in `overview.md`
- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds
- [ ] `npm run dev` serves a page without runtime error
- [ ] Every type, constant, and interface in `contracts.md` §2–§10 exists and is exported from `@/lib/contracts` or `@/lib/ports`
- [ ] `package.json` contains every script from `contracts.md` §12
- [ ] All six fakes satisfy their port interfaces — verified by a type-level assignment, not by hope
- [ ] `fakes/embeddings.embedOne("x")` returns `env.embeddingDim` floats, and two calls give identical arrays
- [ ] Two different strings produce vectors with cosine similarity below 0.5
- [ ] Registry with `*_MODE=fake` returns the fakes; with `real` and the module absent, it falls back to the fake and logs a warning containing `FAKE PORT`
- [ ] All 6 owned fixture files exist and parse as the contract types
- [ ] `fixtures/event-stream.json` contains every field needed to render `reference.png`
- [ ] `assertEmbeddingConfig()` throws on a deliberate model/dimension mismatch
- [ ] `npm run check` exits 0 against a live cluster, non-zero with a corrupted `MONGODB_URI`
- [ ] Cluster tier confirmed Flex or higher, or the M0 deviation is recorded in `contracts.md` and `agents.md`
- [ ] Hot-reloading a file 6 times in dev does not exhaust the Atlas connection pool

## Verification

```bash
npm install
npm run typecheck
npm run build
npm run check

npx tsx -e "
import fx from './src/lib/fakes/embeddings';
import { env } from './src/lib/env';
const a = await fx.embedOne('chest pain'), b = await fx.embedOne('chest pain');
const c = await fx.embedOne('ankle sprain');
const dot = (x,y)=>x.reduce((s,v,i)=>s+v*y[i],0);
console.log('dim', a.length, 'expected', env.embeddingDim);
console.log('deterministic', JSON.stringify(a)===JSON.stringify(b));
console.log('orthogonal-ish', dot(a,c).toFixed(3));
"

npx tsx -e "
import { readFileSync } from 'fs';
for (const f of ['incidents','hits','runbook-chunks','postmortems','event-stream','utterances'])
  console.log(f, JSON.parse(readFileSync('fixtures/'+f+'.json','utf8')).length);
"

EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake npx tsx -e "
import { embeddings, retrieval } from './src/lib/registry';
console.log((await embeddings()).info());
console.log((await retrieval()).signatureMatch === undefined ? 'MISSING' : 'ok');
"
```

## Handoff Note

The moment `npm run typecheck` passes, announce it. Fourteen phases are blocked on exactly that signal, and they can all start in the same minute.
