# Phase 03 — Embeddings Provider

**Status:** PENDING
**Tasks:** US-006
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 20 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Implement the real `EmbeddingsPort`: Voyage as the primary provider with OpenAI as the documented fallback, batched, retried, order-preserving, dimension-asserted, and cached in MongoDB. Four other phases write vectors through this module, so a subtle bug here corrupts a corpus rather than throwing an error.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §9 — the `EmbeddingsPort` interface, verbatim, and the registry rule that fixes this module's path and export style.
- `.ralph/contracts.md` §2 — `EMBED_CACHE` (`_embed_cache`), the collection this phase caches into.
- `.ralph/contracts.md` §13 — the dimension rule and the requirement that every vector write also stores `embeddedText`.
- `.ralph/overview.md` — the ports-and-fakes table, Critical Rule 1 (MongoDB is the only datastore, which is why the cache lives in Mongo), and the environment variable block.
- `src/lib/env.ts` — `env.embeddingProvider`, `env.embeddingModel`, `env.embeddingDim`, `assertEmbeddingConfig()`. Nothing in this phase reads `process.env` directly.
- `src/lib/ports.ts` — import `EmbeddingsPort` from here and assign the default export to it so the compiler enforces the contract.
- `src/lib/fakes/embeddings.ts` — the shape to match behaviorally. Anything true of the fake's output that is not true of this module's output is a bug that will surface in another phase.

## Parallel-Safe Contract

### Files this phase owns

`src/lib/embeddings/**` and nothing else. Concretely, the five files below. `_embed_cache`'s unique index on `hash` belongs to PHASE-02, and `package.json` belongs to PHASE-01.

### Ports consumed

None. This phase is a leaf: it depends on `@/lib/env`, `@/lib/db/client`, `@/lib/contracts`, and the network.

Because it consumes no ports, there is no `*_MODE=fake` switch to set in order to build it. The parallel-safety problem here is different and more awkward: **the real thing needs an API key, and the acceptance criteria must still be checkable without one.** That is solved by a seam. All the logic worth getting wrong — deduplication, ordering, batching, caching, dimension assertion, retry classification — is factored behind `embedWithProvider(provider, texts, inputType)`, which takes the provider as a function argument. Pass a synchronous stub and every one of those behaviors is verifiable with zero network calls and zero keys. Only two thin functions, `embedVoyage` and `embedOpenAI`, actually require a key, and they are verified by a single optional live check.

### Ports implemented

`EmbeddingsPort`, **default-exported from `src/lib/embeddings/index.ts`**. That path is not negotiable: `contracts.md` §9 fixes the registry's real path for this port at `@/lib/embeddings`, the registry resolves it with a static string literal, and no phase may edit the registry. A named export, a differently named file, or an export that is missing one of the three methods all produce the same outcome — the registry logs `FAKE PORT` and silently keeps using the fake, and the demo runs on hash vectors while looking completely healthy.

```ts
import type { EmbeddingsPort } from "@/lib/ports";
const impl: EmbeddingsPort = { embed, embedOne, info };
export default impl;
```

Write it as an annotated `const` exactly like that. The annotation is what makes a missing or misspelled method a compile error instead of a runtime surprise.

## Files to Create

### `src/lib/embeddings/retry.ts`

```ts
export interface HttpishError extends Error {
  status?: number;
  retryable?: boolean;
}

/** 429, 500, 502, 503, 504, and network/timeout errors. Everything else is false. */
export function isRetryable(err: unknown): boolean;

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: { attempts?: number; baseMs?: number; label?: string },
): Promise<T>;
```

Four attempts total (one try plus three retries), `baseMs` of 500, so the backoff is roughly 500 ms, 1 s, 2 s with ±25 percent jitter applied to each delay. Jitter matters because ingestion fires batches in a tight loop; without it, a rate-limited run retries all of its batches at the same instant and gets rate-limited again in lockstep.

**Never retry a 400 or a 401.** A 400 means the request body is malformed and it will be malformed on every attempt, so retrying converts a two-second error into an eight-second error and buries the real message under three timeouts. A 401 means the key is wrong, which is a thirty-second fix that only happens if the error surfaces immediately. Both must fail fast and print the provider's own error text, because Voyage and OpenAI both return a useful message in the body.

Log one line per retry including the label, the attempt number, and the status, so a slow ingestion run visibly explains itself instead of appearing to hang.

### `src/lib/embeddings/batch.ts`

Pure, no I/O, no imports beyond types. This is the file that is unit-tested hardest, because a batching bug is an ordering bug and an ordering bug is invisible.

```ts
export const VOYAGE_MAX_TEXTS = 128;
export const VOYAGE_MAX_APPROX_TOKENS = 120_000;
export const OPENAI_MAX_TEXTS = 256;

/** Rough token estimate. Deliberately crude — 4 characters per token. */
export function approxTokens(text: string): number;

export interface BatchLimits { maxTexts: number; maxApproxTokens?: number }

/** Splits indices (not texts) into batches, preserving input order within and across batches. */
export function planBatches(texts: string[], limits: BatchLimits): number[][];
```

`planBatches` returns arrays of **indices into the original array**, not arrays of strings. That is the whole trick for order preservation: the caller writes each returned vector back to `out[originalIndex]`, so no reassembly step can get the order wrong. Returning strings would force a second positional zip, which is exactly the operation that breaks.

Voyage's per-request ceiling is 128 texts, and a request also fails if the total token count is too large, so split further whenever the running `approxTokens` sum for a batch would exceed 120,000. `text.length / 4` is a deliberately crude estimate; it is conservative for English prose and costs nothing, and the alternative — importing a real tokenizer — adds a dependency and startup cost to save an API call this project will never make often enough to notice. OpenAI's batch cap is 256 texts and needs no token split at the sizes this project sends.

One edge case to handle explicitly: a single text that alone exceeds the token budget must still be emitted as a batch of one rather than dropped or looped on forever. A 1600-character runbook chunk is nowhere near that limit, so this is a guard, not a hot path.

### `src/lib/embeddings/voyage.ts`

```ts
export const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export async function embedVoyage(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]>;
```

`POST` to `VOYAGE_URL` with `Authorization: Bearer ${VOYAGE_API_KEY}` (read through `env`) and a JSON body of `{ input: texts, model: env.embeddingModel, input_type: inputType }`. The response carries `data` as an array of `{ embedding: number[], index: number }`.

**Sort the response by its `index` field before returning.** The API tells you which input each embedding belongs to; use it rather than assuming positional order. This costs one line and removes an entire class of silent corruption.

**`input_type` is the reason Voyage is the primary provider and it must be threaded through correctly.** Voyage embeds documents and queries into deliberately different regions of the space — the model is trained asymmetrically — so passing `"document"` for a search query measurably degrades retrieval quality. It does not error, it does not warn, it just returns worse neighbors, which reads on stage as "the memory system did not recall the right thing." Every corpus write in PHASE-05 and PHASE-06 passes `"document"`; every search in PHASE-07 passes `"query"`.

Wrap the fetch in `withRetry` and attach the HTTP status to the thrown error so `isRetryable` can classify it. Set a 30-second `AbortSignal.timeout` per attempt: without a timeout a hung socket stalls an ingestion run indefinitely, and a hang is much harder to diagnose than a retry.

### `src/lib/embeddings/openai.ts`

```ts
export async function embedOpenAI(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]>;
```

Use the `openai` SDK, which is already a dependency because `src/lib/llm.ts` uses it, and sort the returned `data` by `index` for the same reason as above.

**OpenAI's embedding models have no `input_type` equivalent. Accept the parameter and ignore it.** Do not throw, do not warn, and do not change the signature. Both providers must be interchangeable at the call site so that switching providers is an environment change rather than a code change across four phases.

There is no automatic cross-provider failover, and that is a deliberate decision rather than an omission. Provider selection is by `EMBEDDING_PROVIDER` alone. An automatic fallback from Voyage to OpenAI silently changes the vector dimension from 1024 to 1536 mid-run, which means half a corpus is written at a length the vector index cannot match, and `$vectorSearch` returns nothing for those documents with no error anywhere. Every other safeguard in this project points at that failure mode; this module must not create it.

The fallback is therefore a documented four-minute procedure, and it belongs in `agents.md`:

1. Set `EMBEDDING_PROVIDER=openai`, `EMBEDDING_MODEL=text-embedding-3-small`, `EMBEDDING_DIM=1536`.
2. Run `npm run indexes` — PHASE-02 detects the dimension mismatch and recreates all four vector indexes.
3. Re-run `npm run ingest:runbooks` and `npm run seed` to rewrite the corpus at the new dimension.

### `src/lib/embeddings/cache.ts`

The `_embed_cache` collection. Keys are content hashes, so a re-run of an ingestion script costs nothing.

```ts
import { EMBED_CACHE } from "@/lib/contracts";

export interface EmbedCacheDoc {
  hash: string;                          // sha256 hex of `${model}:${inputType}:${text}`
  model: string;
  inputType: "document" | "query";
  dim: number;
  vector: number[];
  t: Date;
}

export function cacheKey(model: string, inputType: string, text: string): string;

/** One find({ hash: { $in } }). Returns only entries whose dim matches env.embeddingDim. */
export async function getCached(hashes: string[]): Promise<Map<string, number[]>>;

export async function putCached(rows: EmbedCacheDoc[]): Promise<number>;
```

| Field | Type | Notes |
|---|---|---|
| `hash` | `string` | `sha256(`​`${model}:${inputType}:${text}`​`)`, hex. Unique index owned by PHASE-02. |
| `model` | `string` | Stored redundantly for debugging and for cache cleanup by model. |
| `inputType` | `"document" \| "query"` | Part of the key, because Voyage returns different vectors for the same text. |
| `dim` | `number` | Cross-checked on read; a stale entry from a different dimension is ignored, not returned. |
| `vector` | `number[]` | The embedding. |
| `t` | `Date` | Insert time. No TTL — the corpus does not change, and re-embedding it is the cost this cache exists to avoid. |

**The key must include the model and the input type, not just the text.** Omitting the model means a provider switch serves 1024-dimension vectors for a 1536-dimension index. Omitting the input type means a query lookup hits a document embedding from an earlier ingest and quietly gets the worse of the two vectors — the same asymmetry problem as above, arriving through the cache instead of the API.

Why Mongo rather than a local JSON file or Redis: the hackathon's central rule is that MongoDB is the single platform for memory, state, and context, and introducing Redis for a cache invites precisely the question from a judge that this project does not want to answer. It is also genuinely the right choice here, because `npm run seed` gets re-run several times during the build and a shared cache means the second run is instant across processes, which a per-process in-memory map would not give.

Write with `bulkWrite` of `updateOne` + `upsert: true` rather than `insertMany`. Two reasons: `insertMany` throws a duplicate-key error when two texts in one run hash identically, and PHASE-02 may not have run yet, so the unique index may not exist — an upsert is correct in both worlds.

Wrap both cache functions so that a Mongo failure degrades to a cache miss with a single logged warning rather than aborting the embed. A transient Atlas hiccup should slow an ingestion run down, not kill it thirty minutes before the pitch.

### `src/lib/embeddings/index.ts`

The port implementation and the only file other phases reach, always through the registry.

```ts
import type { EmbeddingsPort } from "@/lib/ports";

export type ProviderFn = (
  texts: string[],
  inputType: "document" | "query",
) => Promise<number[][]>;

/** The seam. All logic lives here; the provider is injected so this is testable with no key. */
export async function embedWithProvider(
  provider: ProviderFn,
  texts: string[],
  inputType: "document" | "query",
  opts?: { limits?: BatchLimits; useCache?: boolean },
): Promise<number[][]>;

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]>;
export async function embedOne(text: string, inputType?: "document" | "query"): Promise<number[]>;
export function info(): { provider: string; model: string; dim: number };

const impl: EmbeddingsPort = { embed, embedOne, info };
export default impl;
```

`embedWithProvider` runs these steps in this order:

1. Return `[]` immediately for an empty input array. No network call, no Mongo round trip.
2. Deduplicate identical texts, keeping a map from each unique text to the list of output positions it fills. Duplicates are common — `seed-memory` embeds the same call-type phrasing repeatedly — and this is free.
3. Compute a cache key per unique text and call `getCached` once with all of them.
4. `planBatches` over the misses only, then call `provider` per batch inside `withRetry`, writing each returned vector to `out[originalIndex]`.
5. Assert every returned vector's length against `env.embeddingDim`, and throw naming both numbers: `` `embedding dim mismatch: provider returned 1536, EMBEDDING_DIM is 1024` ``. Both values in the message is what makes this a ten-second fix instead of a bisect.
6. `putCached` the new vectors.
7. Assert `out.length === texts.length` and that no slot is still undefined, then return.

**Step 7 is the assertion that matters most and it is the cheapest one in the file.** Callers zip the returned array against their documents positionally — PHASE-05 does exactly `chunks.map((c, i) => ({ ...c, embedding: vectors[i] }))`. A short array or a reordered one attaches the wrong vector to the wrong document, every write succeeds, the index builds, queries return results, and the results are wrong in a way no error message will ever mention. Retrieval will look mediocre rather than broken, and the natural response is to start tuning RRF weights in PHASE-07. Assert length and completeness so that outcome is impossible.

`embedOne` defaults `inputType` to `"query"`. That is the right default because the batch path is what corpus writes use and they always pass `"document"` explicitly, while a single-text call is almost always a live search. Pass it explicitly at every call site anyway; the default exists to satisfy the interface, not to be relied on.

`info()` returns `{ provider: env.embeddingProvider, model: env.embeddingModel, dim: env.embeddingDim }`. `scripts/check-atlas.ts` and `GET /api/counters` both surface it, which is how somebody notices at hour seven that the demo is running on the wrong model.

Call `assertEmbeddingConfig()` once at module load so a bad model-and-dimension pairing fails at import time rather than after fetching two thousand documents.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `src/lib/embeddings/index.ts` default-exports a value annotated as `EmbeddingsPort`, so a missing or misnamed method is a compile error
- [ ] **Verifiable with all other ports faked:** with `EMBEDDINGS_MODE=real` and no `VOYAGE_API_KEY` set, `embedWithProvider` with a stub provider returns vectors of `env.embeddingDim` for 300 texts without a single network request
- [ ] With a stub provider that returns a vector encoding its input's position, the output vector at index `i` corresponds to `texts[i]` for all 300 inputs, including across batch boundaries
- [ ] `embed([])` resolves to `[]` and makes no network or database call
- [ ] Passing an array containing the same text three times returns three identical vectors and invokes the stub provider with that text exactly once
- [ ] `planBatches` of 300 texts under Voyage limits yields batches of at most 128 indices, the concatenation of all batches equals `[0..299]` in ascending order, and no index appears twice
- [ ] `planBatches` splits a batch further when accumulated `approxTokens` would exceed 120,000, and a single oversized text is emitted as a batch of one
- [ ] A stub provider returning a wrong-length vector causes a throw whose message contains both the returned length and `env.embeddingDim`
- [ ] A stub provider returning fewer vectors than texts causes a throw rather than a short array
- [ ] `isRetryable` returns `true` for 429, 500, 502, 503, 504 and for an `AbortError`, and `false` for 400, 401, 403, 404
- [ ] `withRetry` makes exactly 4 attempts against an always-429 stub and exactly 1 against an always-400 stub
- [ ] `cacheKey` differs for the same text under different `inputType` values and under different models
- [ ] Against a live cluster, embedding 5 texts twice results in the second call reading all 5 from `_embed_cache` and invoking the provider zero times
- [ ] `getCached` ignores a cache document whose `dim` does not equal `env.embeddingDim`
- [ ] `info()` returns the provider, model, and dimension from `env`
- [ ] Optional live check, if `VOYAGE_API_KEY` is present: `embedVoyage(["chest pain"], "query")` returns one vector of length 1024, and the same text embedded as `"document"` and as `"query"` produces two vectors that are not identical
- [ ] Importing the module with a deliberately mismatched `EMBEDDING_MODEL` and `EMBEDDING_DIM` throws at import time

## Verification

On PowerShell, set inline environment variables with `$env:VAR="value"` before the command instead of the `VAR=value cmd` prefix shown here.

```bash
npm run typecheck
```

Order preservation and deduplication across batch boundaries, with no key and no network. This is the core criterion:

```bash
npx tsx -e "
import { embedWithProvider } from './src/lib/embeddings';
import { env } from './src/lib/env';
let calls = 0, seen = 0;
const stub = async (texts: string[]) => {
  calls++; seen += texts.length;
  // vector[0] encodes the text so ordering is checkable
  return texts.map(t => { const v = new Array(env.embeddingDim).fill(0); v[0] = Number(t.split('-')[1]); return v; });
};
const texts = Array.from({ length: 300 }, (_, i) => 'text-' + i);
const out = await embedWithProvider(stub, texts, 'document', { useCache: false });
console.log('length ok', out.length === 300);
console.log('dims ok', out.every(v => v.length === env.embeddingDim));
console.log('order ok', out.every((v, i) => v[0] === i));
console.log('batches', calls, 'texts seen', seen);
const dup = await embedWithProvider(stub, ['text-7','text-7','text-7'], 'document', { useCache: false });
console.log('dedup identical', JSON.stringify(dup[0]) === JSON.stringify(dup[2]));
console.log('empty', JSON.stringify(await embedWithProvider(stub, [], 'query', { useCache: false })));
process.exit(0);
"
```

Batching arithmetic and the dimension assertion:

```bash
npx tsx -e "
import { planBatches, approxTokens, VOYAGE_MAX_TEXTS, VOYAGE_MAX_APPROX_TOKENS } from './src/lib/embeddings/batch';
const texts = Array.from({ length: 300 }, (_, i) => 'x'.repeat(200));
const b = planBatches(texts, { maxTexts: VOYAGE_MAX_TEXTS, maxApproxTokens: VOYAGE_MAX_APPROX_TOKENS });
const flat = b.flat();
console.log('batch sizes', b.map(x => x.length).join(','));
console.log('covers all in order', flat.length === 300 && flat.every((v, i) => v === i));
const huge = planBatches(['y'.repeat(2_000_000)], { maxTexts: 128, maxApproxTokens: 120_000 });
console.log('oversized becomes batch of one', huge.length === 1 && huge[0].length === 1);
process.exit(0);
"

npx tsx -e "
import { embedWithProvider } from './src/lib/embeddings';
const bad = async (t: string[]) => t.map(() => new Array(7).fill(0.1));
try { await embedWithProvider(bad, ['a'], 'query', { useCache: false }); console.log('FAIL: accepted wrong dim'); }
catch (e: any) { console.log('PASS:', e.message); }
const short = async (t: string[]) => [];
try { await embedWithProvider(short, ['a','b'], 'query', { useCache: false }); console.log('FAIL: accepted short array'); }
catch (e: any) { console.log('PASS:', e.message); }
process.exit(0);
"
```

Retry classification and attempt counts:

```bash
npx tsx -e "
import { withRetry, isRetryable } from './src/lib/embeddings/retry';
for (const s of [400,401,403,404,429,500,502,503,504])
  console.log(s, isRetryable(Object.assign(new Error('x'), { status: s })));
let n = 0;
try { await withRetry(async () => { n++; throw Object.assign(new Error('rate limited'), { status: 429 }); }, { attempts: 4, baseMs: 10, label: 'test' }); } catch {}
console.log('429 attempts', n, n === 4 ? 'PASS' : 'FAIL');
let m = 0;
try { await withRetry(async () => { m++; throw Object.assign(new Error('bad request'), { status: 400 }); }, { attempts: 4, baseMs: 10, label: 'test' }); } catch {}
console.log('400 attempts', m, m === 1 ? 'PASS' : 'FAIL');
process.exit(0);
"
```

Cache behavior against a live cluster, and the port resolving through the registry:

```bash
npx tsx -e "
import { cacheKey, getCached, putCached } from './src/lib/embeddings/cache';
import { env } from './src/lib/env';
const k = cacheKey(env.embeddingModel, 'document', 'chest pain');
const k2 = cacheKey(env.embeddingModel, 'query', 'chest pain');
console.log('inputType changes key', k !== k2);
await putCached([{ hash: k, model: env.embeddingModel, inputType: 'document', dim: env.embeddingDim, vector: new Array(env.embeddingDim).fill(0.01), t: new Date() }]);
await putCached([{ hash: k, model: env.embeddingModel, inputType: 'document', dim: env.embeddingDim, vector: new Array(env.embeddingDim).fill(0.01), t: new Date() }]);
console.log('upsert twice ok, cached', (await getCached([k, k2])).size === 1);
process.exit(0);
"

EMBEDDINGS_MODE=real npx tsx -e "
import { embeddings } from './src/lib/registry';
const em = await embeddings();
console.log(em.info());
console.log('all methods present', ['embed','embedOne','info'].every(k => typeof (em as any)[k] === 'function'));
process.exit(0);
"
```

Optional live provider check, only when a key is present:

```bash
npx tsx -e "
import { embedVoyage } from './src/lib/embeddings/voyage';
const d = await embedVoyage(['chest pain radiating to the left arm'], 'document');
const q = await embedVoyage(['chest pain radiating to the left arm'], 'query');
console.log('dim', d[0].length);
console.log('asymmetric', JSON.stringify(d[0]) !== JSON.stringify(q[0]) ? 'PASS' : 'FAIL: input_type ignored');
process.exit(0);
"
```

## Handoff Note

Announce that `@/lib/embeddings` default-exports a working `EmbeddingsPort` and state the dimension it produces. Until that message lands, PHASE-05 and PHASE-06 should keep running with `EMBEDDINGS_MODE=fake`, which is a perfectly good way to build a chunker or a seeder — but nobody should embed a real corpus twice, so the switch to `real` is worth coordinating.
