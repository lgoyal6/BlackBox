# Phase 06 — Seeded Memory (postmortems + remediations)

**Status:** COMPLETE
**Tasks:** US-010, US-011
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 30 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Build the corpus that makes the second demo call retrieve anything at all: **about 40** `postmortems` narratives and their matching `remediations`, derived from real closed NYC incidents where the dispatch read was wrong. Templated generation is the default. The `decisions` collection is left deliberately empty.

## Why This Phase Is Load-Bearing

Without seeded memory, call two in the demo retrieves nothing and the entire thesis collapses. One call demonstrates a dictation tool; two calls demonstrate memory. The difference between those two outcomes is this corpus.

Two consequences follow, and both are non-negotiable:

1. **Run the seed before going on stage.** Never generate live. Even forty LLM calls have a nonzero failure rate, which is why `--templated` is the default.
2. **Never seed the `decisions` collection** (Critical Rule 5). It stays empty until the demo and fills live from the voice call. That emptiness *is* the demo: you show `decisions` at zero, run a call, show it non-zero. The script must assert `decisions` is still empty when it finishes and exit non-zero if it is not.
3. **Do not enlarge `SEED_TARGET`.** Forty narratives plus two curated ones is enough for call two to retrieve a neighbour. Four hundred is a warehouse job.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §5 — `PostmortemDoc`, `RemediationDoc`, `IncidentDoc`, `GroundTruth`, `CadFields`. Implement these literally.
- `.ralph/contracts.md` §4 — `callTypeFamily()`, `labelFor()`, `MemoryOrigin`, `RemediationOutcome`, severity direction (lower = more severe).
- `.ralph/contracts.md` §13 — every vector write sets both `embedding` and `embeddedText`; `EMBEDDING_DIM` must equal the index `numDimensions`.
- `.ralph/overview.md` — Critical Rules 5, 6, and 8; the file ownership table; the NYC field list.
- `fixtures/incidents.json` (PHASE-01) — six incident docs, historical ones carrying `_groundTruth`. This is what you test selection and derivation against with no network and no ingested data.
- `fixtures/postmortems.json` (PHASE-01) — six `PostmortemDoc` shapes without embeddings, including the diversion narrative. Use it to check that what you write matches the contract shape.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `src/lib/memory/seed.ts` | Selection, derivation, narrative generation, writing |
| `scripts/seed-memory.ts` | CLI entry point, wired to the existing `npm run seed` script |
| `fixtures/curated-postmortems.json` | The 2–3 curated demo narratives |

`src/lib/memory/` is shared as a directory with PHASE-09, which owns `decisions.ts`, `postmortem.ts`, and `epcr.ts` in the same folder. Do not create, edit, or import those three files. Do not touch `package.json` — `"seed": "tsx scripts/seed-memory.ts"` already exists in the contract's script list (§12), so there is nothing to add.

### Ports consumed

| Port | Used for | Set this to build in isolation |
|---|---|---|
| `EmbeddingsPort` | Embedding every narrative and remediation text | `EMBEDDINGS_MODE=fake` |
| `LlmPort` | One narrative per incident | `LLM_MODE=fake` |

Both come from `@/lib/registry`. With both set to `fake` there is zero network dependency and no API key, so this phase is fully buildable and verifiable while PHASE-03 (real embeddings) is still being written. The fake embeddings produce deterministic unit vectors of `env.embeddingDim`, which is exactly what the write-path assertions need.

This phase writes to Atlas, so it needs a reachable cluster and the collections to exist, but it needs no other phase's code. If PHASE-04 has not ingested incidents yet, the script runs against `fixtures/incidents.json` under `--from-fixtures` and still exercises every code path.

### Ports implemented

None. This phase exports plain functions and a script. Nothing here is resolved through the registry, so there is no default-export requirement.

## Files to Create

### `src/lib/memory/seed.ts`

The whole phase's logic lives here so the script stays a thin argument parser.

```ts
export interface SeedOptions {
  target?: number;        // default SEED_TARGET (40)
  templated?: boolean;    // default SEED_DEFAULT_TEMPLATED (true)
  llm?: boolean;          // opt-in LLM narratives; default false
  concurrency?: number;   // default 8
  seed?: number;          // default 20260813 — fixed so rehearsals are identical
  fromFixtures?: boolean; // default false — read fixtures/incidents.json instead of Atlas
  curatedOnly?: boolean;  // default false
  dryRun?: boolean;       // default false — select and generate, write nothing
}

export interface SeedSelection {
  incident: IncidentDoc;          // carries _groundTruth; see the exception note below
  transition: string;             // "UNC->ARREST"
  severityDelta: number;          // initial - final; positive = undertriaged
  reopened: boolean;
  totalSeconds: number | null;
  familyMedianSeconds: number | null;
}

export interface SeedReport {
  selected: number;
  postmortemsWritten: number;
  remediationsWritten: number;
  curatedWritten: number;
  byTransition: Record<string, number>;
  outcomes: { success: number; failure: number };
  narrativeMode: "llm" | "templated";
  llmFailures: number;
  decisionsCount: number;         // MUST be 0
  elapsedMs: number;
}

export async function familyMedians(): Promise<Map<CallTypeFamily, number>>;
export async function selectSeedIncidents(opts: SeedOptions): Promise<SeedSelection[]>;
export function computeCostMinutes(totalSeconds: number | null, medianSeconds: number | null): number | null;
export function deriveRemediations(sels: SeedSelection[]): RemediationDraft[];
export function templatedNarrative(sel: SeedSelection): string;
export async function buildNarrative(sel: SeedSelection, opts: { templated: boolean }): Promise<{ narrative: string; lessons: string[] }>;
export async function loadCurated(): Promise<CuratedEntry[]>;
export async function seedMemory(opts: SeedOptions): Promise<SeedReport>;

export function wordCount(s: string): number;
export async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]>;
```

`mapWithConcurrency` is written here rather than pulled from npm because `package.json` belongs to PHASE-01 and adding a dependency mid-build is a merge conflict. Twenty lines of a worker-pool loop is cheaper than the conflict.

#### Reading `_groundTruth` is allowed here, and only here

Critical Rule 6 quarantines `_groundTruth` from every retrieval path and graph node. Seeding scripts are the documented exception (`contracts.md` §13). This phase reads it because the historical outcome *is* the memory being recorded — a postmortem about a closed 2023 call is supposed to know how that call ended. What must never happen is a live incident's own ground truth leaking into a brief during the demo, and nothing in this phase runs at demo time.

#### Selection

Query `incidents` for closed historical records where the final call type diverged from dispatch:

```ts
{
  isLive: false,
  _groundTruth: { $exists: true },
  "cad.initialSeverityLevelCode": { $gte: 1, $lte: 8 },
  $expr: { $ne: ["$_groundTruth.finalCallType", "$cad.initialCallType"] },
}
```

The field-to-field comparison requires `$expr`; a plain `$ne` against a field path silently compares to the literal string and returns everything.

Stratify the `SEED_TARGET` (40) selections so no single transition dominates:

| Bucket | Minimum | Why |
|---|---|---|
| `UNC` → `ARREST` | `SEED_STRATA.uncArrest` (15) | Demo call 1 pattern. |
| `SICK` → `CARD` | `SEED_STRATA.sickCard` (15) | Demo call 2 pattern. |
| All other divergent transitions | `SEED_STRATA.other` (10) | Breadth, so retrieval is not a two-cluster lookup table. |

Hard constraint on the remainder: **no single transition may exceed 15% of `target`.** Without that cap the high-volume transitions swallow the tail and every query returns the same handful of neighbours.

Within every bucket, prefer `severityDelta > 0` (undertriaged — the call was upgraded after arrival). Those carry the most signal because somebody's first read was wrong in the direction that matters.

Selection must be **deterministic**. Do not use `$sample`, which cannot be seeded. Instead pull a candidate pool per bucket with `.sort({ incidentId: 1 }).limit(target * 5)`, then choose from it with a small seeded PRNG (mulberry32 over `opts.seed` is fine) with `severityDelta > 0` sorted first and the PRNG breaking ties. Two runs with the same `--seed` must select the identical set of `incidentId`s, because a rehearsal that retrieves different neighbours than the live run is not a rehearsal.

#### Family medians and `costMinutes`

Compute the median total time per `callTypeFamily` **once**, in a single aggregation, before touching any rows. Recomputing per row turns a 30-minute phase into a 3-minute-per-run phase.

```ts
// one $match + one $group over the same candidate filter, keyed by callTypeFamily
```

If the cluster reports MongoDB 7.0 or newer — print the version from `ping()` in `@/lib/db/client` — the `$median` accumulator with `method: "approximate"` does this server-side. Confirm it against your actual server version before relying on it; if the aggregation errors on an unrecognized accumulator, `$push` the durations and take the median in TypeScript. Either path is acceptable; computing it more than once is not.

**`incidentTotalSeconds` is derived from real fields, never invented:**

```
incidentTotalSeconds = _groundTruth.incidentResponseSeconds + _groundTruth.incidentTravelSeconds
                     (falling back to incidentResponseSeconds alone when travel is null,
                      and to null when both are null)
```

Use the **same** formula in the median aggregation and in the per-row computation. A median computed over response-only seconds compared against a per-row response-plus-travel number produces a `costMinutes` that is wrong by the average travel time on every single document, and nothing about the output will look broken.

```
costMinutes = max(0, (incidentTotalSeconds - familyMedianTotalSeconds) / 60)
```

Round to one decimal. Return `null` when either input is null — never substitute a zero, because `null` means "we do not know" and `0` means "it was not slow", and the brief says one of those out loud.

This matters because the demo speaks a number: "the nearest facility was on diversion there and cost eleven minutes." A number derived from the dataset survives a judge asking where it came from. A number someone typed does not.

#### `deriveRemediations`

Maps real outcome signals to `RemediationOutcome`. Failures are the valuable ones (Critical Rule 8), and these rules pre-label a few hundred of them for free:

| Rule | Outcome | `sideEffects` entry |
|---|---|---|
| `_groundTruth.reopenIndicator === true` | `failure` | `"incident reopened"` |
| `severityDelta > 0` | `failure` | `"undertriaged: severity ${initial} to ${final}"` |
| `totalSeconds > 1.5 * familyMedianSeconds` | `failure` | `"slow: ${ratio}x family median"` |
| none of the above | `success` | `[]` |

The rules are OR-ed into `failure`; evaluate all three and record every reason that fired, since a reopened *and* slow incident is a stronger memory than either alone.

Each draft becomes a `RemediationDoc` per `contracts.md` §5:

| Field | Value |
|---|---|
| `incidentId` | from the incident |
| `action` | `` `handled as ${labelFor(cad.initialCallType)}` `` |
| `outcome` | from the rules above |
| `durationSeconds` | `incidentTotalSeconds` |
| `costMinutes` | from `computeCostMinutes` |
| `sideEffects` | the reasons that fired |
| `origin` | `"seeded"` |
| `callTypeFamily` | `callTypeFamily(cad.initialCallType)` |
| `embeddedText` | action + outcome + reasons + expanded call type labels, one short paragraph |
| `embedding` | from `EmbeddingsPort.embed(texts, "document")` |
| `t` | the incident datetime, not `new Date()` — this is historical memory |

Phrasing `action` as "handled as *general illness*" rather than a clinical action is deliberate: PHASE-08's `Plan` node turns failed remediations into `excludedPaths`, and "continuing to handle this as a general illness, which failed on incident 5942 and cost eleven minutes" is a sentence that both fits the contract and stays entirely on the logistics side of the scope guardrail.

#### Narratives

One `LlmPort.text()` call per incident. The prompt must produce:

- **60 to 110 words.** The contract permits 40–200; stay inside 60–110. Longer narratives retrieve worse because the signal gets diluted across the embedding, and they read badly aloud.
- **First person plural, past tense**, the register of a real crew debrief. "We were sent for an unconscious male and found him pulseless on arrival."
- **What was dispatched, what it actually turned out to be, and what the tell was** — the observable detail that should have flipped the read sooner. The tell is the retrievable part; a narrative without one is just a label restated.
- Where the incident was reopened or unusually slow, **what cost the time**.

**Never invent vitals, drug doses, or patient identifiers.** State this in the prompt in those words and enforce it after generation: reject and re-template any narrative matching `/\d+\s*(mg|mcg|mL|g)\b/i`. This corpus gets read aloud by the agent during the demo, and a hallucinated dose spoken out loud is exactly the failure mode judges are watching for. The only numbers permitted in a narrative are the derived `costMinutes` and severity codes.

Run generation through `mapWithConcurrency` with a limit of 8. Four hundred narratives lands in roughly 2–4 minutes at that concurrency. Higher limits hit provider rate limits and the retries cost more than the parallelism saves.

Per-narrative failures fall back to the template and increment `llmFailures`. **If more than 10% fail, stop the run and print "already defaulting to templated"** rather than grinding through retries.

#### The templated fallback

`templatedNarrative(sel)` is a pure string template over the same fields, behind `--templated`:

> We were dispatched for a {labelFor(initial)} in {borough}, {dispatchArea}. It was closed as a {labelFor(final)}. The severity was {upgraded to / downgraded to / held at} level {final}. {Reopen or slow clause, when applicable, naming the derived costMinutes.}

It still produces embeddable, retrievable text. Retrieval quality drops because the wording is uniform across documents and the embeddings cluster tightly, but the demo works. State the tradeoff plainly to yourself before you start debugging: burning twenty minutes on concurrent LLM calls for prettier seed narratives is a bad trade against a working second call. If the LLM path is not clean within ten minutes, ship `--templated` and move on.

#### Writing and idempotency

Delete before writing, scoped by origin:

```ts
await col(POSTMORTEMS).deleteMany({ origin: "seeded" });
await col(REMEDIATIONS).deleteMany({ origin: "seeded" });
```

`curated` and `live` documents are never touched. This is what makes the script safe to run twice at hour six, and it is the same rule `POST /api/demo/reset` follows in `contracts.md` §10.

Insert in chunks of 500 with `{ ordered: false }`. Embed in batches through `EmbeddingsPort.embed(texts, "document")` (batched, not one call per document) and assert every returned vector has length `env.embeddingDim` before writing. A dimension mismatch produces empty search results with no error — the most expensive failure mode in this build.

Finish by counting `decisions`. If it is not zero, print what is in there and exit non-zero.

### `scripts/seed-memory.ts`

Thin CLI over `seedMemory`. Already wired as `npm run seed`.

| Flag | Default | Effect |
|---|---|---|
| `--target=N` | `SEED_TARGET` (40) | Number of seeded incidents |
| `--templated` | off | Skip the LLM entirely |
| `--concurrency=N` | 8 | LLM parallelism |
| `--seed=N` | 20260813 | PRNG seed for selection |
| `--from-fixtures` | off | Read `fixtures/incidents.json` instead of Atlas |
| `--curated-only` | off | Re-render only the curated entries |
| `--dry-run` | off | Select and generate, write nothing |

Print the `SeedReport` as a readable table: counts, the transition histogram, the success/failure split, `llmFailures`, narrative mode, elapsed time, and the `decisions` count with an explicit `OK (must be 0)` marker next to it. Exit non-zero on any assertion failure.

### `fixtures/curated-postmortems.json`

Two or three curated narratives containing the specific detail the agent quotes on stage — receiving-facility diversion, the time it cost, the routing decision that followed.

**The NYC dataset has no diversion field, so that detail is synthetic.** Handle it honestly rather than hiding it:

- Attach each curated narrative to a **real** ingested `incidentId`, with **real** response-time numbers and a **real** derived `costMinutes`.
- Mark it `origin: "curated"` so it is distinguishable from `"seeded"` and `"live"` in every query, on the dashboard, and in the database.
- Keep the count at two or three. If a large share of retrieval hits come back curated, the retrieval is theater and a judge who clicks into the data will see it immediately. The bulk seeded corpus is what makes retrieval real; the curated few are what make one spoken line land. Do not blur the line, and if a judge asks directly, say which is which.

Shape — an object rather than a bare array, because the provenance note has to live next to the data:

```jsonc
{
  "note": "Curated demo narratives. The receiving-facility diversion detail is SYNTHETIC; the NYC EMS dataset has no diversion field. Every other number in these narratives (costMinutes, response seconds, incidentId, displayId) is derived from a real ingested incident at seed time.",
  "entries": [
    {
      "id": "diversion-b3",
      "select": { "initialCallType": "UNC", "finalCallType": "ARREST", "dispatchArea": "B3" },
      "narrativeTemplate": "... {{costMinutes}} ... {{displayId}} ... {{dispatchArea}} ... {{label}} ...",
      "lessons": ["Confirm receiving facility status before committing to a destination."],
      "whatChangedTemplate": "{{initialCallType}} → {{finalCallType}}"
    }
  ]
}
```

The narrative is a **template**, not fixed prose. The placeholders `{{costMinutes}}`, `{{displayId}}`, `{{dispatchArea}}`, `{{label}}`, `{{initialCallType}}`, and `{{finalCallType}}` are filled at seed time from the bound incident. That is what makes "it cost eleven minutes" a number out of the dataset instead of a number out of a text editor.

Binding rules in `seedMemory`:

1. Find a real incident matching `select`. If none matches exactly, relax to the same `callTypeFamily` transition ignoring `dispatchArea`, and print which incident it bound to.
2. If `incidents` is empty because PHASE-04 has not run, **skip curated with a clear warning and continue.** Curated entries must never block the bulk seed.
3. Write them as `PostmortemDoc` with `origin: "curated"`, alongside a matching `RemediationDoc` with `origin: "curated"` and the same derived `costMinutes`.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] With `EMBEDDINGS_MODE=fake LLM_MODE=fake`, `npm run seed -- --target=20 --templated --from-fixtures` completes and exits 0 with **no other phase's code present**
- [ ] After any successful run, `db.decisions.countDocuments({})` is exactly `0`, and the script exits non-zero if it is not
- [ ] Running the script twice in a row produces identical `postmortems` and `remediations` counts (idempotent), and any document with `origin` of `"curated"` or `"live"` present before the second run still exists after it
- [ ] At default `--target=40` against ingested data, the transition histogram shows at least 15 `UNC->ARREST` and at least 15 `SICK->CARD`
- [ ] Two runs with the same `--seed` select an identical set of `incidentId`s; two runs with different seeds do not
- [ ] Every written `postmortems` and `remediations` document has a non-empty `embeddedText` and an `embedding` array whose length equals `env.embeddingDim`
- [ ] Every seeded narrative has a word count between 60 and 110 inclusive
- [ ] No seeded or curated narrative matches `/\d+\s*(mg|mcg|mL|g)\b/i`
- [ ] `computeCostMinutes` returns `null` when either input is null, never a negative number, and one decimal place otherwise
- [ ] `deriveRemediations` produces `failure` for a reopened incident, for `severityDelta > 0`, and for a total time above 1.5× the family median, and `success` otherwise — checked against four hand-built `SeedSelection` fixtures
- [ ] Family medians are computed with exactly one aggregation call per run (verifiable by logging the call count or by inspection)
- [ ] `fixtures/curated-postmortems.json` parses, contains at most 3 entries, and carries the `note` field naming the synthetic detail
- [ ] Every written curated postmortem has `origin: "curated"` and an `incidentId` that exists in the `incidents` collection
- [ ] Curated documents are at most `CURATED_POSTMORTEM_CAP` (3)
- [ ] `--templated` completes with zero LLM calls (verifiable by running with no `OPENAI_API_KEY` set and `LLM_MODE=real`)

## Verification

PowerShell users: set env vars with `$env:EMBEDDINGS_MODE='fake'` on a preceding line rather than the inline prefix shown here.

```bash
npm run typecheck

# Full parallel-safe run: no Atlas data, no API keys, no other phase.
EMBEDDINGS_MODE=fake LLM_MODE=fake \
  npx tsx scripts/seed-memory.ts --target=20 --templated --from-fixtures

# Idempotency: run twice, counts must not move.
EMBEDDINGS_MODE=fake LLM_MODE=fake npx tsx scripts/seed-memory.ts --target=20 --templated
EMBEDDINGS_MODE=fake LLM_MODE=fake npx tsx scripts/seed-memory.ts --target=20 --templated

# decisions must still be empty, and the corpus must look right.
npx tsx -e "
import { col } from './src/lib/db/client';
import { DECISIONS, POSTMORTEMS, REMEDIATIONS } from './src/lib/contracts';
console.log('decisions', await col(DECISIONS).countDocuments({}));
console.log('postmortems', await col(POSTMORTEMS).countDocuments({}));
console.log('by origin', await col(POSTMORTEMS).aggregate([
  { \$group: { _id: '\$origin', n: { \$sum: 1 } } }]).toArray());
console.log('remediation outcomes', await col(REMEDIATIONS).aggregate([
  { \$group: { _id: '\$outcome', n: { \$sum: 1 } } }]).toArray());
process.exit(0);
"

# Narrative discipline: word bounds and the no-dose rule.
npx tsx -e "
import { col } from './src/lib/db/client';
import { POSTMORTEMS } from './src/lib/contracts';
const docs = await col(POSTMORTEMS).find({}).toArray();
const wc = (s) => s.trim().split(/\s+/).length;
const bad = docs.filter(d => wc(d.narrative) < 60 || wc(d.narrative) > 110);
const dosed = docs.filter(d => /\d+\s*(mg|mcg|mL|g)\b/i.test(d.narrative));
console.log('out of word range', bad.length, 'contains a dose', dosed.length);
process.exit(bad.length || dosed.length ? 1 : 0);
"

# Determinism of selection.
npx tsx -e "
import { selectSeedIncidents } from './src/lib/memory/seed';
const a = await selectSeedIncidents({ target: 20, seed: 20260813 });
const b = await selectSeedIncidents({ target: 20, seed: 20260813 });
const c = await selectSeedIncidents({ target: 20, seed: 7 });
const ids = (x) => x.map(s => s.incident.incidentId).join(',');
console.log('same seed identical', ids(a) === ids(b));
console.log('different seed differs', ids(a) !== ids(c));
process.exit(0);
"
```

## Handoff Note

Announce the transition histogram and the final `postmortems` count when this finishes. PHASE-07 tunes `SIGNATURE_MATCH_FLOOR` against this exact corpus, and PHASE-15 rehearses against it, so both need to know it exists and how big it is.
