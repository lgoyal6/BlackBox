# Phase 04 — NYC Dispatch Ingestion and the Pitch Number

**Status:** PENDING
**Tasks:** US-007, US-008
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 30 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Ingest roughly two thousand real NYC EMS dispatch records into `incidents` as `IncidentDoc`s with the answers quarantined under `_groundTruth`, and compute the two numbers the pitch stands on: the headline reclassification statistic for the slide, and the per-call-type reclassification priors that the agent speaks during the brief.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §3 — the three id forms and `toDisplayId` / `toRef`. Mixing them up is the most likely cross-phase bug, and this phase produces all three.
- `.ralph/contracts.md` §4 — `callTypeFamily()`, `CODE_LABELS`, `labelFor()`, and the severity direction rule.
- `.ralph/contracts.md` §5 — `IncidentDoc`, `CadFields`, `GroundTruth`, `PUBLIC_INCIDENT_PROJECTION`. Implement these field names exactly.
- `.ralph/contracts.md` §6 — `ReclassPrior`, the output shape of the priors computation.
- `.ralph/overview.md` — "Data Sources → Primary", the verified sample row keys, the severity-direction table, Critical Rules 6 and 7, and the pitch metrics table this phase must reproduce.
- `reference.png` — confirms that the dashboard header displays a unit (`14B`) and a dispatch area (`B3`), which is why this phase synthesizes `cad.unit`.
- `fixtures/incidents.json` — PHASE-01 ships six incident documents including `_groundTruth`. Use them to test `toIncidentDoc`'s output shape and the quarantine rule with zero network access.

## Parallel-Safe Contract

### Files this phase owns

Exactly three, from the ownership table in `overview.md`:

- `src/lib/ingest/nyc.ts`
- `scripts/ingest-incidents.ts`
- `scripts/compute-pitch-number.ts`

Both npm scripts already exist in `package.json` from PHASE-01 (`ingest:incidents` and `pitch`), so nothing outside these three files gets touched. This phase also writes two artifacts under `data/`, which is gitignored and shared by filename convention: `data/pitch-numbers.json` and `data/reclass-priors.json`. PHASE-05 writes only `data/nasemso-*`, so there is no collision.

### Ports consumed

None, and that is worth stating precisely because it is surprising: **`IncidentDoc` has no `embedding` field, so ingestion needs no embeddings at all.** Incidents are the input to the demo, not part of the retrievable corpus; PHASE-06 is what turns history into embedded memory. If code in this phase reaches for the embeddings port, it is doing PHASE-06's job and should stop.

Run every command with all port modes forced to `fake` anyway, so that no real module is ever loaded and this phase provably cannot be blocked by another:

```
EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake GRAPH_MODE=fake VOICE_MODE=fake
```

Two real external dependencies remain: the Socrata API, which needs no auth, and Mongo. **This phase must work whether or not PHASE-02 has run.** Deduplication comes from the upsert filter on `incidentId`, never from PHASE-02's unique index, and no index is created here. Verify that by running against a fresh database with no indexes at all — the upsert creates the collection implicitly and idempotency still holds.

### Ports implemented

None. Nothing here is default-exported or resolved through the registry. The deliverables are documents in `incidents` and two JSON files under `data/`.

## Files to Create

### `src/lib/ingest/nyc.ts`

Fetching, transformation, upserting, and the priors aggregation. Every pure function is exported separately so it can be tested against `fixtures/incidents.json` without touching the network.

```ts
import type { IncidentDoc, ReclassPrior } from "@/lib/contracts";

export const SOCRATA_URL = "https://data.cityofnewyork.us/resource/76xm-jjuj.json";
export const SINCE = "2024-01-01T00:00:00";

export type SliceName = "demo_arrest" | "demo_cardiac" | "divergent" | "control";
export interface SliceSpec { name: SliceName; where: string; limit: number }
export const SLICES: readonly SliceSpec[];

/** All values arrive as strings. Every field is optional because Socrata omits nulls. */
export type SocrataRow = Record<string, string | undefined>;

export async function fetchSlice(
  slice: SliceSpec,
  opts?: { pageSize?: number; appToken?: string; onPage?: (n: number, total: number) => void },
): Promise<SocrataRow[]>;

export function toInt(v: string | undefined): number | null;
export function toNum(v: string | undefined): number | null;
/** Appends "Z" before parsing. See "Datetimes" below — this is deliberate. */
export function toDate(v: string | undefined): Date | null;
export function toBool(v: string | undefined): boolean;

/** Deterministic from incidentId. The dataset has no unit field. */
export function synthesizeUnit(incidentId: string): string;

/** Returns null when the row must be dropped. `reason` is pushed to `drops` for reporting. */
export function toIncidentDoc(
  row: SocrataRow,
  opts?: { now?: Date; drops?: string[] },
): IncidentDoc | null;

export async function upsertIncidents(
  docs: IncidentDoc[],
): Promise<{ matched: number; upserted: number; modified: number }>;

/** Codes present in the data with no entry in CODE_LABELS. */
export function verifyCodeLabels(docs: IncidentDoc[]): { code: string; count: number }[];

/** UTC hour >= 22 or < 6. See "Datetimes" for why UTC is correct here. */
export function isNight(d: Date): boolean;

export async function computeReclassPriors(
  opts?: { minSampleSize?: number; topN?: number },
): Promise<ReclassPrior[]>;
```

#### Socrata request construction

The endpoint takes no auth. Send `X-App-Token` only when `SOCRATA_APP_TOKEN` is set; the token raises the shared per-IP rate limit, and this phase makes fewer than a dozen requests, so its absence is never the problem.

Two gotchas that were verified live and will each cost twenty confusing minutes if ignored:

**Always send `$order=incident_id`.** Socrata paging without an explicit `$order` is not stable across pages: the same row can appear on two pages while another is never returned at all. There is no error and no warning, so the symptom is a row count that changes between runs and a demo incident that exists on one machine and not another.

**Never hand-build the query string.** An unencoded space or operator inside `$where` makes Socrata return **an empty body with HTTP 200**. Not a 400, not an error message — a successful response containing nothing, which reads exactly like "the dataset has no rows matching this filter" and sends you off to rewrite a filter that was already correct. Build parameters with `URLSearchParams` (or fetch's params handling) and let it encode. If a slice ever returns zero rows, re-check the encoding before re-checking the predicate.

Page with `$limit` of 1000 and an incrementing `$offset`, stopping when a page comes back shorter than the page size or when the slice's own limit is reached. Set a 30-second `AbortSignal.timeout` per request and retry twice on a 5xx; conference wifi is a real failure mode and two retries cost nothing.

#### The four slices

All four carry `incident_datetime > '${SINCE}'` in addition to their own predicate. The single-quoted literal is SoQL string syntax and survives URL encoding untouched.

| Slice | Additional `$where` | Limit | Why it exists |
|---|---|---|---|
| `demo_arrest` | `initial_call_type='UNC' AND final_call_type='ARREST'` | 200 | Demo call 1. The exact transition the first scripted call reproduces. |
| `demo_cardiac` | `initial_call_type='SICK' AND final_call_type='CARD'` | 200 | Demo call 2. A different dispatch label with the same latent pattern, which is what makes vector retrieval visibly semantic rather than a string lookup. |
| `divergent` | `initial_call_type!=final_call_type` | 1200 | The general reclassification population. Feeds the priors and gives PHASE-06 a corpus with real labeled triage errors. |
| `control` | `initial_call_type=final_call_type` | 400 | Calls that were what they said they were. Without these, every prior computes to 100 percent reclassification and the brief line becomes nonsense. |

Roughly 2000 documents total. `final_call_type` is never null across all 29,978,154 rows, so the `!=` predicate needs no null guard.

The `divergent` slice overlaps `demo_arrest` and `demo_cardiac` by construction, since a `UNC`→`ARREST` call is also divergent. Handle it by deduplicating on `incidentId` in memory before upserting, and report the overlap count to stdout. **Do not add a `slice` field to `IncidentDoc` to track provenance.** That is a shared type, so adding a field to it is a contract change requiring an edit to `contracts.md` and an entry in `agents.md`, and nothing downstream needs it: PHASE-11's `/api/demo/fire` can select its demo incident by `cad.initialCallType` of `UNC` or `SICK`, which is a dispatch-time field and therefore not a ground-truth read.

#### Transformation

`toIncidentDoc` maps one row. Every source value is a string, including numbers and datetimes.

| Socrata key | Destination | Type | Notes |
|---|---|---|---|
| `incident_id` | `incidentId` | `string` | The identifier. **Not `CAD_INCIDENT_ID`** — that name appears in the portal's documentation but not in the JSON API. Drop the row if absent. |
| — | `displayId` | `string` | `toDisplayId(incidentId)`. |
| — | `ref` | `string` | `toRef(incidentId, cad.incidentDatetime)`. |
| — | `status` | `IncidentStatus` | Literal `"closed"`. These are historical records. |
| — | `isLive` | `boolean` | Literal `false`. `/api/demo/reset` deletes `isLive: true` only, so getting this wrong means the reset wipes the seed corpus. |
| — | `timeline` | `TimelineEntry[]` | Literal `[]`. Historical rows have no captured narration. |
| `initial_call_type` | `cad.initialCallType` | `string` | Drop the row if absent. |
| `initial_severity_level_code` | `cad.initialSeverityLevelCode` | `number` | `toInt`; drop the row unless 1–8 inclusive. |
| `borough` | `cad.borough` | `string` | Empty string when absent. |
| `zipcode` | `cad.zipcode` | `string` | Empty string when absent. |
| `incident_dispatch_area` | `cad.dispatchArea` | `string` | The `B3` in the dashboard header and in the brief line. |
| — | `cad.unit` | `string` | Synthesized. See below. |
| `incident_datetime` | `cad.incidentDatetime` | `Date` | `toDate`; drop the row if unparseable. |
| — | `callTypeFamily` | `CallTypeFamily` | `callTypeFamily(initial_call_type)`. **From the initial code, never the final one** — deriving it from `final_call_type` would leak the answer into a field every agent path reads. |
| `final_call_type` | `_groundTruth.finalCallType` | `string` | Quarantined. |
| `final_severity_level_code` | `_groundTruth.finalSeverityLevelCode` | `number` | `toInt`; drop the row unless 1–8. |
| — | `_groundTruth.severityDelta` | `number` | `initialSeverityLevelCode - finalSeverityLevelCode`. Positive means upgraded, which means undertriaged on the initial read. |
| `incident_close_datetime` | `_groundTruth.incidentCloseDatetime` | `Date \| null` | |
| `incident_disposition_code` | `_groundTruth.incidentDispositionCode` | `string \| null` | |
| `reopen_indicator` | `_groundTruth.reopenIndicator` | `boolean` | `=== "Y"`. Pre-labeled failure memory. |
| `dispatch_response_seconds_qy` | `_groundTruth.dispatchResponseSeconds` | `number \| null` | `toNum`; an empty string becomes `null`, not `0` or `NaN`. |
| `incident_response_seconds_qy` | `_groundTruth.incidentResponseSeconds` | `number \| null` | Same. |
| `incident_travel_tm_seconds_qy` | `_groundTruth.incidentTravelSeconds` | `number \| null` | Same. |
| — | `createdAt`, `updatedAt` | `Date` | `opts.now ?? new Date()`, so tests are deterministic. |

Everything else on the row is dropped: `first_assignment_datetime`, `first_activation_datetime`, `first_on_scene_datetime`, `first_to_hosp_datetime`, `first_hosp_arrival_datetime`, the two `valid_*_indc` flags, `held_indicator`, `special_event_indicator`, `standby_indicator`, `transfer_indicator`, `policeprecinct`, `citycouncildistrict`, `communitydistrict`, `communityschooldistrict`, `congressionaldistrict`. None of them appear in `IncidentDoc`, and storing extras invites a later reader to treat one as agent-visible.

**Critical Rule 6 is the whole point of that table's lower half.** Six categories of field describe what the call turned out to be, and all of them live under `_groundTruth`: the final call type, the final severity, the close time, the disposition code, the reopen flag, and every response-time measurement. The `_groundTruth` key is the exact spelling in `contracts.md` §5, which is also what `PUBLIC_INCIDENT_PROJECTION` excludes; use that spelling. A leak here does not produce a bug, it produces a demo where the agent appears prescient and a judge who correctly concludes the retrieval was never doing any work.

`toNum` must treat `""` and `undefined` as `null` and never as `0`. A zero response time is a real value that means something different from a missing one, and a `NaN` written into Mongo becomes a document that breaks the closing metrics script rather than the ingest.

`synthesizeUnit` must be **deterministic from `incidentId`** — for example, digits derived from the id modulo 40 plus one, concatenated with a letter chosen from the same digits. The dataset genuinely has no unit field and `reference.png` displays one, so it has to be invented; making it deterministic means a re-run does not change the unit shown in the dashboard header between rehearsals. A random unit per run is the kind of tiny inconsistency that makes a demo look unrehearsed.

#### Datetimes

Socrata returns naive ISO strings such as `2005-01-01T00:00:24.000` — NYC wall-clock time with no zone marker. JavaScript's `new Date()` parses a string in that form as **local** time, so on a laptop in San Francisco every timestamp shifts by three hours. That silently flips the night flag for calls between 22:00 and 01:00 and can push `ref`'s `YYMMDD` prefix onto the wrong day.

`toDate` therefore appends `Z` before parsing, storing the dataset's wall-clock reading as a UTC instant. That is intentional and consistent: nothing in this project does cross-timezone arithmetic, the dashboard clock and the night flag both want the original local reading, and any other choice makes `ref` depend on the machine's timezone — which means the demo's incident reference changes when the laptop travels to San Francisco.

The consequence for `isNight` is that it reads the **UTC** hour, and the priors aggregation calls `$hour` with no `timezone` argument. Note this in `agents.md`, since it is the sort of decision a later reader will otherwise "fix."

One objectively checkable consequence worth including in the criteria: a row whose `incident_datetime` is `2024-03-05T01:12:00.000` must produce a `ref` beginning `240305`. If it comes out `240304`, `toRef` is using local getters and that is a PHASE-01 bug to report in `agents.md` rather than something to work around here.

#### Upserting

```ts
col<IncidentDoc>(INCIDENTS).bulkWrite(
  docs.map(d => ({ updateOne: { filter: { incidentId: d.incidentId }, update: { $set: {...}, $setOnInsert: { createdAt: d.createdAt } }, upsert: true } })),
  { ordered: false },
);
```

Filter on `incidentId` and never on `_id`. `$setOnInsert` for `createdAt` so a second run does not rewrite it, and `$set` for everything else including `updatedAt`. `ordered: false` so one bad document does not abort the remaining batch. Batch in groups of 500.

Idempotency comes from this filter, not from PHASE-02's unique index, which is what lets this phase run first.

#### Code label verification

`verifyCodeLabels` returns every `cad.initialCallType` present in the ingested set that has **no key in `CODE_LABELS`**, with a count. Check key presence in the map directly; do not call `labelFor()`, which humanizes unknown codes by design and therefore can never tell you a code is missing.

`CODE_LABELS` lives in `src/lib/contracts/domain.ts`, which PHASE-01 owns. **This phase reports misses; it does not add entries.** A missing label is a contract change: add it to `contracts.md` §4, note it in `agents.md`, and let PHASE-01's file be edited once.

The tradeoff to state out loud, so nobody rediscovers it: the dataset ships an official code list as an xlsx attachment at

```
https://data.cityofnewyork.us/api/views/76xm-jjuj/files/1f3c87df-ffa3-4bda-a63c-45aeac003a26?download=true&filename=EMS_incident_dispatch_data_description.xlsx
```

Parsing it means adding an xlsx dependency and reverse-engineering the sheet layout, which is fifteen minutes for codes the demo will never speak. The curated map in `contracts.md` covers the twenty codes that matter, including every code in both demo slices. Download the xlsx only if `verifyCodeLabels` surfaces an unknown code that actually appears in a demo path.

#### Reclassification priors

These power the brief line in `reference.png`: "this call type in B3 reclassifies to cardiac 18 percent of the time overnight." The output type is `ReclassPrior` from `contracts.md` §6.

A `$group` over ingested incidents, keyed on `cad.initialCallType`, `cad.dispatchArea`, a night flag, and `_groundTruth.finalCallType`, counting occurrences; then reshape into one `ReclassPrior` per `(initialCallType, dispatchArea, nightOnly)` combination with the top `topN` final call types by percentage.

| Field | Value |
|---|---|
| `initialCallType` | The group's `cad.initialCallType`. |
| `dispatchArea` | The group's `cad.dispatchArea`, or `null` for the area-agnostic rollup. |
| `nightOnly` | `true` for the night-hours group, `false` for the all-hours group. |
| `sampleSize` | Total incidents in the group. |
| `top` | Up to `topN` entries (default 3) of `{ finalCallType, family, pct, n }`, sorted by `pct` descending. `family` is `callTypeFamily(finalCallType)`. `pct` is `n / sampleSize * 100`, rounded to one decimal. |

Emit three tiers so PHASE-07 always has something to serve: `(callType, area, night)`, `(callType, area, all hours)`, and `(callType, null, all hours)`. Suppress any group whose `sampleSize` is below `minSampleSize` (default 8) — a prior computed from three calls is a number that sounds authoritative and means nothing, and this one gets spoken aloud on stage.

The night expression, given that stored dates are UTC-labeled wall clock:

```ts
{ $let: { vars: { h: { $hour: "$cad.incidentDatetime" } },
          in: { $or: [{ $gte: ["$$h", 22] }, { $lt: ["$$h", 6] }] } } }
```

**This aggregation reads `_groundTruth`, and that is allowed here.** Critical Rule 6 permits ground-truth reads in seeding scripts and the closing metrics script, and this is a seeding script. The distinction that keeps the demo honest: a prior is a population-level statistic over two thousand historical calls, not the answer to the call currently in progress. Saying "this call type reclassifies to cardiac 18 percent of the time overnight" reveals nothing about what *this* patient turns out to have. Write that reasoning into the file as a comment, because it is the one place where reading the quarantined field is correct and somebody will otherwise flag it.

Write the result to `data/reclass-priors.json` as a plain array of `ReclassPrior`. **PHASE-04 produces the file and stops there.** `RetrievalPort.reclassPrior(initialCallType, dispatchArea)` is PHASE-07's to implement and PHASE-07 reads this file; do not write a serving function, an API route, or a port implementation here.

### `scripts/ingest-incidents.ts`

Behind `npm run ingest:incidents`. Steps, each printing its own report:

1. Fetch each slice in `SLICES`, printing rows fetched per slice and pages consumed.
2. Transform with `toIncidentDoc`, collecting drop reasons.
3. Deduplicate on `incidentId`, printing the overlap count.
4. `upsertIncidents` in batches, printing matched / upserted / modified.
5. `verifyCodeLabels`, printing any unlabeled codes with counts, or a line confirming full coverage.
6. `computeReclassPriors`, writing `data/reclass-priors.json` and printing the top three priors for `UNC` and for `SICK` — the two the demo actually speaks.
7. Print a summary table and exit 0, or the failure and exit 1.

Flags:

- `--slice=<name>` — run one slice, for iterating on the transform without refetching 2000 rows.
- `--limit=<n>` — override the slice limit, for a 10-row smoke test.
- `--dry-run` — fetch and transform, print three sample documents as formatted JSON, write nothing to Mongo.
- `--priors-only` — skip fetching entirely and recompute the priors from what is already in Mongo. This is the flag that gets used most, because the priors are the part worth iterating on and refetching to change a rounding rule is wasteful. There is deliberately no separate npm script for it: `contracts.md` §12 fixes the script list, and adding one means editing `package.json`, which PHASE-01 owns.

Close the Mongo client in a `finally` block so the script exits instead of hanging on an open pool.

Print a drop summary rather than dropping silently: `dropped 7 rows (4 severity out of range, 3 unparseable datetime)`. Roughly 311 rows in 30 million carry severity 0 or 9, so the expected drop count in a 2000-row sample is zero or one. A drop count in the hundreds means the transform is wrong, not the data.

### `scripts/compute-pitch-number.ts`

Behind `npm run pitch`. Queries Socrata's aggregate endpoint, prints a table, and writes `data/pitch-numbers.json`.

Use `$select=count(1) AS n` with a `$where` per metric and read the first row's `n`, falling back to the first value of the returned object if the alias is absent. Note that Socrata returns the count as a string, so cast it.

| Key | `$where` | Expected |
|---|---|---|
| `total_incidents` | none | 29,978,154 |
| `total_2023` | `incident_datetime>'2023-01-01T00:00:00'` | 5,653,498 |
| `divergent_2023` | `incident_datetime>'2023-01-01T00:00:00' AND initial_call_type!=final_call_type` | 845,887 |
| `divergent_all` | `initial_call_type!=final_call_type` | 2,750,007 |
| `undertriage_2023` | `incident_datetime>'2023-01-01T00:00:00' AND final_severity_level_code<initial_severity_level_code` | 400,548 |
| `reopened_all` | `reopen_indicator='Y'` | 237,210 |

Derived percentages, each rounded to one decimal except the last:

| Key | Formula | Expected |
|---|---|---|
| `divergent_2023_pct` | `divergent_2023 / total_2023 * 100` | 15.0 |
| `divergent_all_pct` | `divergent_all / total_incidents * 100` | 9.2 |
| `undertriage_2023_pct` | `undertriage_2023 / total_2023 * 100` | 7.1 |
| `reopened_all_pct` | `reopened_all / total_incidents * 100` | 0.79 |

`divergent_2023_pct` is the headline: one in seven New York EMS calls turns out to be something other than what it was dispatched as.

One note on the undertriage comparison. The severity codes arrive as strings, so SoQL compares them as text — but every valid code is a single character, which makes lexicographic and numeric ordering identical, so the comparison is correct as written. That is only true because the range is 1–8. If a future query compares a multi-digit numeric text column, it needs an explicit `::number` cast.

`data/pitch-numbers.json`:

| Field | Type | Notes |
|---|---|---|
| `computedAt` | ISO string | When the network call ran. |
| `source` | `string` | `"socrata:76xm-jjuj"`. |
| `metrics` | array | One entry per key above. |
| `metrics[].key` | `string` | From the tables. |
| `metrics[].where` | `string \| null` | The exact predicate sent, so the number is auditable. |
| `metrics[].value` | `number` | Freshly computed. |
| `metrics[].expected` | `number` | The verified value from the table. |
| `metrics[].drift` | `boolean` | `true` when fresh and expected disagree beyond tolerance. |

**Caching is the point of this script, not an optimization.** Default behavior: if `data/pitch-numbers.json` exists, print from it and make no network request at all. Refetch only with `--refresh`. Conference wifi is the most reliable way to lose a pitch, and a live aggregate query over 30 million rows in front of judges is an unforced risk for a number that has not changed. Since `data/` is gitignored, the file will not arrive with a `git clone` — run `npm run pitch --refresh` once on the demo machine well before the pitch, and add that to the PHASE-15 preflight checklist.

Drift handling: tolerance is 0.1 percentage point for percentages and 0.5 percent of the expected value for counts. When a fresh number disagrees, **trust the fresh number**, print a loud block naming the metric, both values, and the exact instruction that `overview.md`'s metrics table and the pitch slide both need updating, and record `drift: true` in the JSON. Do not silently overwrite and do not silently keep the old value. The slide and the script must never disagree on stage, and the only way to guarantee that is to make a disagreement impossible to miss. Note the drift in `agents.md` as well; editing `overview.md` is a deliberate act, not a side effect of running a script.

Support `--offline` as an explicit alias of the default cached behavior, so the preflight script can state its intent, and exit non-zero if `--offline` is passed and the cache file does not exist.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run ingest:incidents` exits 0 and upserts between 1500 and 2000 distinct incidents
- [ ] Every ingested document validates as `IncidentDoc`: `status: "closed"`, `isLive: false`, `timeline: []`, and non-empty `incidentId`, `displayId`, and `ref`
- [ ] `db.incidents.countDocuments({ isLive: true })` is 0 after ingestion
- [ ] No ingested document has any of `final_call_type`, `final_severity_level_code`, `incident_close_datetime`, `incident_disposition_code`, `reopen_indicator`, or any `*_seconds_qy` field outside `_groundTruth` — verified by a query, not by reading the code
- [ ] A `find` with `PUBLIC_INCIDENT_PROJECTION` returns documents on which `_groundTruth` is `undefined`
- [ ] Every document's `cad.initialSeverityLevelCode` and `_groundTruth.finalSeverityLevelCode` is an integer in 1–8
- [ ] `_groundTruth.severityDelta` equals `cad.initialSeverityLevelCode - _groundTruth.finalSeverityLevelCode` for every document
- [ ] `cad.incidentDatetime` and `_groundTruth.incidentCloseDatetime` are BSON dates, not strings, verified with `$type`
- [ ] At least 150 documents match `cad.initialCallType: "UNC"` with `_groundTruth.finalCallType: "ARREST"`, and at least 150 match `SICK` → `CARD`
- [ ] At least 300 documents have `cad.initialCallType` equal to `_groundTruth.finalCallType`, so priors are not uniformly 100 percent
- [ ] `callTypeFamily` is derived from `cad.initialCallType` for every document, checked by recomputing it and comparing
- [ ] Running `npm run ingest:incidents` twice does not increase the document count, and every `createdAt` is unchanged by the second run
- [ ] Ingestion succeeds against a database where `npm run indexes` has never run
- [ ] **Verifiable with all other ports faked:** with every `*_MODE=fake`, `toIncidentDoc` applied to each row-shaped entry derived from `fixtures/incidents.json` produces the expected quarantine split with zero network calls and zero API keys
- [ ] `toNum("")` returns `null`; `toInt("9")` and `toInt("0")` cause the row to be dropped with a recorded reason
- [ ] A row with `incident_datetime` of `2024-03-05T01:12:00.000` produces a `ref` beginning `240305` regardless of the machine's timezone
- [ ] `synthesizeUnit` returns the same value for the same `incidentId` across two runs and matches `/^\d{1,2}[A-Z]$/`
- [ ] `verifyCodeLabels` returns an empty array, or the run prints the unlabeled codes and counts and the miss is recorded in `agents.md`
- [ ] `data/reclass-priors.json` exists, parses as `ReclassPrior[]`, contains at least one entry for `UNC` and one for `SICK`, and every entry has `sampleSize >= 8` with `top` sorted by `pct` descending
- [ ] Every `top[].pct` is between 0 and 100, and every `top[].family` equals `callTypeFamily(top[].finalCallType)`
- [ ] `--priors-only` recomputes the priors file without issuing a single Socrata request
- [ ] `npm run pitch` with no cache file present fetches, writes `data/pitch-numbers.json`, and prints all ten metrics
- [ ] `npm run pitch` with the cache file present makes zero network requests
- [ ] `npm run pitch --offline` exits non-zero when the cache file is absent
- [ ] Every metric in the fresh computation matches its expected value within tolerance, or the run prints a drift block naming the metric and both values and records `drift: true`
- [ ] `divergent_2023_pct` in the output file is 15.0

## Verification

On PowerShell, set inline environment variables with `$env:VAR="value"` before the command instead of the `VAR=value cmd` prefix shown here.

```bash
npm run typecheck

# Transform only, no writes. Confirms the fetch and the quarantine split.
EMBEDDINGS_MODE=fake npx tsx scripts/ingest-incidents.ts --slice=demo_arrest --limit=10 --dry-run

# Full ingest, then a second run to prove idempotency.
EMBEDDINGS_MODE=fake npm run ingest:incidents
EMBEDDINGS_MODE=fake npm run ingest:incidents
```

The quarantine check, which is the criterion that protects Critical Rule 6:

```bash
npx tsx -e "
import { col } from './src/lib/db/client';
import { INCIDENTS, PUBLIC_INCIDENT_PROJECTION } from './src/lib/contracts';
const c = col(INCIDENTS);
console.log('total', await c.countDocuments());
console.log('isLive true (want 0)', await c.countDocuments({ isLive: true }));
const leaked = await c.countDocuments({ \$or: [
  { final_call_type: { \$exists: true } }, { finalCallType: { \$exists: true } },
  { final_severity_level_code: { \$exists: true } }, { reopen_indicator: { \$exists: true } },
  { incident_close_datetime: { \$exists: true } }, { incident_disposition_code: { \$exists: true } },
  { dispatch_response_seconds_qy: { \$exists: true } }, { incident_response_seconds_qy: { \$exists: true } },
]});
console.log('leaked answer fields (want 0)', leaked);
const pub = await c.findOne({}, { projection: PUBLIC_INCIDENT_PROJECTION });
console.log('projection hides groundTruth', (pub as any)?._groundTruth === undefined);
console.log('date types ok', await c.countDocuments({ 'cad.incidentDatetime': { \$type: 'date' } }));
console.log('severity in range', await c.countDocuments({ 'cad.initialSeverityLevelCode': { \$gte: 1, \$lte: 8 } }));
console.log('UNC->ARREST', await c.countDocuments({ 'cad.initialCallType': 'UNC', '_groundTruth.finalCallType': 'ARREST' }));
console.log('SICK->CARD', await c.countDocuments({ 'cad.initialCallType': 'SICK', '_groundTruth.finalCallType': 'CARD' }));
process.exit(0);
"
```

Pure transform functions, with no network and no keys:

```bash
EMBEDDINGS_MODE=fake npx tsx -e "
import { toIncidentDoc, toNum, toInt, toDate, synthesizeUnit, isNight } from './src/lib/ingest/nyc';
console.log('toNum empty', toNum(''), 'toInt 9', toInt('9'));
const drops: string[] = [];
const row = { incident_id: '16975942', incident_datetime: '2024-03-05T01:12:00.000',
  initial_call_type: 'UNC', initial_severity_level_code: '2', final_call_type: 'ARREST',
  final_severity_level_code: '1', borough: 'MANHATTAN', zipcode: '10029',
  incident_dispatch_area: 'B3', incident_close_datetime: '2024-03-05T02:41:00.000',
  incident_disposition_code: '82', reopen_indicator: 'N',
  dispatch_response_seconds_qy: '31', incident_response_seconds_qy: '', incident_travel_tm_seconds_qy: '240' };
const d = toIncidentDoc(row, { drops })!;
console.log('ref', d.ref, d.ref.startsWith('240305') ? 'PASS' : 'FAIL timezone');
console.log('family from initial', d.callTypeFamily);
console.log('delta', d._groundTruth?.severityDelta, d._groundTruth?.severityDelta === 1 ? 'PASS' : 'FAIL');
console.log('empty seconds -> null', d._groundTruth?.incidentResponseSeconds === null);
console.log('unit stable', synthesizeUnit('16975942') === synthesizeUnit('16975942'), synthesizeUnit('16975942'));
console.log('night', isNight(d.cad.incidentDatetime));
console.log('bad severity dropped', toIncidentDoc({ ...row, initial_severity_level_code: '9' }, { drops }) === null, drops);
process.exit(0);
"
```

Priors and labels:

```bash
EMBEDDINGS_MODE=fake npx tsx scripts/ingest-incidents.ts --priors-only

npx tsx -e "
import { readFileSync } from 'fs';
import { callTypeFamily } from './src/lib/contracts';
const priors = JSON.parse(readFileSync('data/reclass-priors.json','utf8'));
console.log('entries', priors.length);
console.log('has UNC', priors.some((p:any)=>p.initialCallType==='UNC'));
console.log('has SICK', priors.some((p:any)=>p.initialCallType==='SICK'));
console.log('minSample ok', priors.every((p:any)=>p.sampleSize>=8));
console.log('sorted + pct ok', priors.every((p:any)=>p.top.every((t:any,i:number)=>
  t.pct>=0 && t.pct<=100 && t.family===callTypeFamily(t.finalCallType) && (i===0||p.top[i-1].pct>=t.pct))));
console.log(JSON.stringify(priors.find((p:any)=>p.initialCallType==='UNC'), null, 2));
process.exit(0);
"
```

The pitch number:

```bash
rm -f data/pitch-numbers.json
npm run pitch                # fetches once, writes the cache
npm run pitch                # must make zero network requests
npm run pitch -- --offline    # prints from cache

npx tsx -e "
import { readFileSync } from 'fs';
const p = JSON.parse(readFileSync('data/pitch-numbers.json','utf8'));
for (const m of p.metrics) console.log(m.key, m.value, 'expected', m.expected, m.drift ? 'DRIFT' : 'ok');
const h = p.metrics.find((m:any)=>m.key==='divergent_2023_pct');
console.log('headline', h.value, h.value === 15.0 ? 'PASS' : 'CHECK overview.md');
process.exit(0);
"
```

## Handoff Note

Announce three things: the ingested document count, whether `verifyCodeLabels` came back empty, and whether any pitch metric drifted. PHASE-06 needs the incident corpus to exist before it can seed memory from it, PHASE-07 needs `data/reclass-priors.json` to implement `reclassPrior`, and PHASE-15 needs to know which number goes on the slide.
