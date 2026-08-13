# Phase 04 — NYC Dispatch Ingestion and the Pitch Number

**Status:** PENDING
**Tasks:** US-007, US-008
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 30 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Pull a small demo slice of real NYC EMS dispatch records into `incidents` as `IncidentDoc`s with the answers quarantined under `_groundTruth`, and compute the two statistics the pitch stands on — the headline reclassification number for the slide and the per-call-type reclassification priors the agent speaks during the brief — from Socrata aggregate queries that never download a row.

## Demo scale (locked — do not enlarge)

This is a one-day demo, not a warehouse. The constants live in `contracts.md` §14 as `DEMO_SLICES`, `SOCRATA_BASE`, and `SOCRATA_YEAR_FLOOR`. **Import them; do not restate the limits or the URL in this phase's code.** Four SODA row requests, roughly 180 documents:

| Slice | Predicate (beyond the 2024 floor) | Limit |
|---|---|---|
| `arrest` | `initial_call_type='UNC' AND final_call_type='ARREST'` | 40 |
| `cardiac` | `initial_call_type='SICK' AND final_call_type='CARD'` | 40 |
| `divergent` | `initial_call_type!=final_call_type` | 80 |
| `control` | `initial_call_type=final_call_type` | 20 |

`control` is not filler. Without calls that turned out to be what they were dispatched as, every reclassification prior computes to 100 percent and the spoken brief line becomes nonsense.

Three hard limits, all of them ways this phase otherwise eats an hour:

- **Never download the bulk CSV.** `rows.csv?accessType=DOWNLOAD` is several gigabytes.
- **Never raise a `$limit` past its §14 constant**, and never send a `$limit` at or above 1000.
- **Never page.** One request per slice. The 15.0 percent headline is a different kind of query — `$select=count(1)` aggregates against the full city dataset, which return one number each. That is how you get a city-wide statistic without a city-wide download.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §14 — `SOCRATA_BASE`, `SOCRATA_YEAR_FLOOR`, `DEMO_SLICES`. These are the frozen scale constants and this phase's only source for them.
- `.ralph/contracts.md` §3 — the three id forms and `toDisplayId` / `toRef`. This phase produces all three, and mixing them up is the most likely cross-phase bug.
- `.ralph/contracts.md` §4 — `callTypeFamily()`, `CODE_LABELS`, `labelFor()`, and the severity direction rule.
- `.ralph/contracts.md` §5 — `IncidentDoc`, `CadFields`, `GroundTruth`, `PUBLIC_INCIDENT_PROJECTION`. Implement these field names exactly, including the `_groundTruth` spelling.
- `.ralph/contracts.md` §6 — `ReclassPrior`, the output shape of the priors file.
- `.ralph/overview.md` — "Data Sources → Primary", the verified sample row keys, the severity-direction table, Critical Rules 6 and 7, and the metrics table this phase must reproduce.
- `reference.png` — confirms the dashboard header shows a unit (`14B`) and a dispatch area (`B3`), which is why this phase synthesizes `cad.unit`.
- `fixtures/incidents.json` — PHASE-01 ships six incident documents including `_groundTruth`, so the transform and the quarantine rule are testable with no network access.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `src/lib/ingest/nyc.ts` | Fetch, transform, upsert, aggregate |
| `scripts/ingest-incidents.ts` | CLI behind `npm run ingest:incidents` |
| `scripts/compute-pitch-number.ts` | CLI behind `npm run pitch` |

Nothing else. Both npm scripts already exist in `package.json` from PHASE-01. Do not edit `package.json`, and do not add entries to `CODE_LABELS` — that map lives in `src/lib/contracts/domain.ts`, which PHASE-01 owns, so a missing label gets reported here and added there.

This phase writes two gitignored artifacts: `data/pitch-numbers.json` and `data/reclass-priors.json`. PHASE-05 writes only `data/nasemso-*`, so the filenames cannot collide.

### Ports consumed

None, and that is worth stating precisely because it is surprising: **`IncidentDoc` has no `embedding` field, so ingestion needs no embeddings at all.** Incidents are the input to the demo, not part of the retrievable corpus; PHASE-06 is what turns history into embedded memory. If code here reaches for the embeddings port, it is doing PHASE-06's job.

Run every command in this spec with all port modes forced to `fake`, so no real module is ever loaded and this phase provably cannot be blocked by another:

```
EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake LLM_MODE=fake EVENTS_MODE=fake GRAPH_MODE=fake VOICE_MODE=fake
```

Two real external dependencies remain: Socrata, which needs no auth, and Mongo. **This phase must work whether or not PHASE-02 has run.** Idempotency comes from the upsert filter on `incidentId`, never from PHASE-02's unique index, and this phase creates no indexes. Verify that against a fresh database.

### Ports implemented

None. Nothing here is default-exported or resolved through the registry. The deliverables are documents in `incidents` and two JSON files under `data/`. In particular, `RetrievalPort.reclassPrior` is PHASE-07's to implement — **this phase produces `data/reclass-priors.json` and stops there.** Do not write a serving function, an API route, or a port implementation, and do not import `@/lib/retrieval`.

## Verified Socrata facts (2026-08-13 — do not re-derive)

- Endpoint is `SOCRATA_BASE`, no auth. Send an `X-App-Token` header when `SOCRATA_APP_TOKEN` is set; it raises the shared per-IP rate limit, and since this phase makes fewer than a dozen requests, its absence is never the problem.
- JSON keys are **lowercase snake_case**, and the identifier is **`incident_id`, not `CAD_INCIDENT_ID`** — the uppercase name appears in the portal's documentation but not in the API.
- **Every value arrives as a string**, including numbers and datetimes. Datetimes are naive ISO, like `2005-01-01T00:00:24.000`.
- `final_call_type` is never null across all 29,978,154 rows, so `!=` needs no null guard.
- Severity: lower code means more severe, valid range 1–8. Codes 0 and 9 are noise, 1 and 310 rows respectively.
- **Always send `$order=incident_id`, even though this phase does not page.** Socrata's row order without an explicit `$order` is not stable, so the same limit returns a slightly different 40 rows on different runs. That makes a demo incident exist on one machine and not another, with no error to explain it.
- **Never hand-build the query string.** An unencoded space or operator inside `$where` makes Socrata return **an empty body with HTTP 200** — not a 400, not a message, just a successful response containing nothing, which reads exactly like "the dataset has no rows matching this filter" and sends you off to rewrite a predicate that was already correct. Pass parameters through `URLSearchParams` and let it encode. If a slice returns zero rows, check the encoding before the predicate.

## Files to Create

### `src/lib/ingest/nyc.ts`

```ts
import { DEMO_SLICES, SOCRATA_BASE } from "@/lib/contracts";
import type { IncidentDoc, ReclassPrior } from "@/lib/contracts";

export type SocrataRow = Record<string, string | undefined>;
export type DemoSlice = (typeof DEMO_SLICES)[number];

export async function fetchSlice(slice: DemoSlice): Promise<SocrataRow[]>;

export function toInt(v: string | undefined): number | null;
export function toNum(v: string | undefined): number | null;
/** Appends "Z" before parsing. See "Datetimes" below — this is deliberate. */
export function toDate(v: string | undefined): Date | null;
export function toBool(v: string | undefined): boolean;

/** Deterministic from incidentId. The dataset has no unit field. */
export function synthesizeUnit(incidentId: string): string;

/** Returns null when the row must be dropped; the reason is pushed to opts.drops. */
export function toIncidentDoc(row: SocrataRow, opts?: { now?: Date; drops?: string[] }): IncidentDoc | null;

export interface IngestReport {
  fetched: Record<string, number>;
  transformed: number;
  duplicatesAcrossSlices: number;
  dropped: { reason: string; count: number }[];
  upserted: number;
  modified: number;
  familyHistogram: Record<string, number>;
  unlabeledCodes: { code: string; count: number }[];
}
export async function loadIncidents(opts?: { dryRun?: boolean }): Promise<IngestReport>;

/** Codes present in the data with no key in CODE_LABELS. */
export function verifyCodeLabels(docs: IncidentDoc[]): { code: string; count: number }[];

export interface PitchMetric {
  key: string;
  where: string | null;
  value: number;
  expected: number;
  drift: boolean;
}
export interface PitchNumbers { computedAt: string; source: string; metrics: PitchMetric[] }

export async function computePitchNumbers(opts?: { refresh?: boolean }): Promise<PitchNumbers>;
export async function computeReclassPriors(opts?: { topN?: number; minSampleSize?: number }): Promise<ReclassPrior[]>;
```

#### Transformation

`toIncidentDoc` maps one row. Every source value is a string.

| Socrata key | Destination | Type | Notes |
|---|---|---|---|
| `incident_id` | `incidentId` | `string` | Drop the row if absent. |
| — | `displayId` | `string` | `toDisplayId(incidentId)`. |
| — | `ref` | `string` | `toRef(incidentId, cad.incidentDatetime)`. |
| — | `status` | `IncidentStatus` | Literal `"closed"`. These are historical records. |
| — | `isLive` | `boolean` | Literal `false`. `/api/demo/reset` deletes `isLive: true` only, so getting this wrong means the reset wipes the seed corpus. |
| — | `timeline` | `TimelineEntry[]` | Literal `[]`. Historical rows carry no narration. |
| `initial_call_type` | `cad.initialCallType` | `string` | Drop the row if absent. |
| `initial_severity_level_code` | `cad.initialSeverityLevelCode` | `number` | `toInt`; drop the row unless 1–8. |
| `borough` | `cad.borough` | `string` | Empty string when absent. |
| `zipcode` | `cad.zipcode` | `string` | Empty string when absent. |
| `incident_dispatch_area` | `cad.dispatchArea` | `string` | The `B3` in the dashboard header and in the brief line. |
| — | `cad.unit` | `string` | Synthesized; see below. |
| `incident_datetime` | `cad.incidentDatetime` | `Date` | `toDate`; drop the row if unparseable. |
| — | `callTypeFamily` | `CallTypeFamily` | `callTypeFamily(initial_call_type)`. **From the initial code, never the final one** — deriving it from `final_call_type` leaks the answer into a field every agent path reads. |
| `final_call_type` | `_groundTruth.finalCallType` | `string` | Quarantined. |
| `final_severity_level_code` | `_groundTruth.finalSeverityLevelCode` | `number` | `toInt`; drop the row unless 1–8. |
| — | `_groundTruth.severityDelta` | `number` | `initial - final`. Positive means upgraded, which means undertriaged on the first read. |
| `incident_close_datetime` | `_groundTruth.incidentCloseDatetime` | `Date \| null` | |
| `incident_disposition_code` | `_groundTruth.incidentDispositionCode` | `string \| null` | |
| `reopen_indicator` | `_groundTruth.reopenIndicator` | `boolean` | `=== "Y"`. Pre-labeled failure memory. |
| `dispatch_response_seconds_qy` | `_groundTruth.dispatchResponseSeconds` | `number \| null` | `toNum`; empty string becomes `null`, never `0` or `NaN`. |
| `incident_response_seconds_qy` | `_groundTruth.incidentResponseSeconds` | `number \| null` | Same. |
| `incident_travel_tm_seconds_qy` | `_groundTruth.incidentTravelSeconds` | `number \| null` | Same. |
| — | `createdAt`, `updatedAt` | `Date` | `opts.now ?? new Date()`, so tests are deterministic. |

Every other key on the row is dropped — the `first_*_datetime` fields, the two `valid_*_indc` flags, `held_indicator`, `special_event_indicator`, `standby_indicator`, `transfer_indicator`, and the five district and precinct fields. None appear in `IncidentDoc`, and storing extras invites a later reader to treat one as agent-visible.

**Critical Rule 6 is the point of that table's lower half.** Six categories of field describe what the call turned out to be — final call type, final severity, close time, disposition code, reopen flag, and every response-time measurement — and all of them live under `_groundTruth`. Use exactly that spelling; it is what `contracts.md` §5 declares and what `PUBLIC_INCIDENT_PROJECTION` excludes. Note that `overview.md`'s Critical Rule 6 writes it as `_ground_truth`; the contract wins, and the discrepancy belongs in `agents.md`. A leak here does not produce a bug, it produces a demo where the agent appears prescient and a judge who correctly concludes retrieval was never doing any work.

`toNum` must treat `""` and `undefined` as `null` and never as `0`. A zero response time is a real value meaning something different from a missing one, and a `NaN` written to Mongo produces a document that breaks the closing metrics script rather than the ingest.

`synthesizeUnit` must be **deterministic from `incidentId`** — for example, a number from the id's digits modulo 40 plus one, concatenated with a letter picked from the same digits, matching `/^\d{1,2}[A-Z]$/`. The dataset genuinely has no unit field and `reference.png` displays one, so it must be invented; determinism means a re-run does not change the unit in the dashboard header between rehearsals. A unit that shuffles every run is the kind of small inconsistency that makes a demo look unrehearsed.

#### Datetimes

Socrata returns naive ISO strings with no zone marker, and JavaScript's `new Date()` parses that form as **local** time. On a laptop in San Francisco every NYC timestamp shifts by three hours, which can push `ref`'s `YYMMDD` prefix onto the wrong day for early-morning calls.

`toDate` therefore appends `Z` before parsing, storing the dataset's wall-clock reading as a UTC instant. That is intentional and consistent: nothing in this project does cross-timezone arithmetic, the dashboard clock wants the original local reading, and any other choice makes the demo's incident reference change when the laptop travels. Record the decision in `agents.md`, because it is exactly the sort of thing a later reader will try to "fix."

One checkable consequence: a row whose `incident_datetime` is `2024-03-05T01:12:00.000` must produce a `ref` beginning `240305` on any machine. If it comes out `240304`, `toRef` is using local getters — report that in `agents.md` as a PHASE-01 bug rather than working around it here.

#### Upserting

```ts
col<IncidentDoc>(INCIDENTS).bulkWrite(
  docs.map(d => ({ updateOne: {
    filter: { incidentId: d.incidentId },
    update: { $set: { /* everything except createdAt */ }, $setOnInsert: { createdAt: d.createdAt } },
    upsert: true,
  }})),
  { ordered: false },
);
```

Filter on `incidentId`, never `_id`. `$setOnInsert` for `createdAt` so a second run does not rewrite it. `ordered: false` so one bad document does not abort the batch.

The `divergent` slice overlaps `arrest` and `cardiac` by construction, since a `UNC`→`ARREST` call is also divergent. Deduplicate on `incidentId` in memory before upserting and report the overlap count. **Do not add a `slice` field to `IncidentDoc`** to track provenance: it is a shared type, so that is a contract change, and nothing needs it — PHASE-11's `/api/demo/fire` can select its demo incident by `cad.initialCallType` of `UNC` or `SICK`, which is a dispatch-time field and therefore not a ground-truth read.

#### Code label verification

`verifyCodeLabels` returns every `cad.initialCallType` in the ingested set that has **no key in `CODE_LABELS`**, with a count. Check key presence in the map directly. **Do not route this through `labelFor()`** — by contract §4 it humanizes unknown codes and never returns the bare code, so it can never tell you a code is missing.

The tradeoff to state so nobody rediscovers it: the dataset ships an official code list as an xlsx attachment at

```
https://data.cityofnewyork.us/api/views/76xm-jjuj/files/1f3c87df-ffa3-4bda-a63c-45aeac003a26?download=true&filename=EMS_incident_dispatch_data_description.xlsx
```

Parsing it means a new xlsx dependency plus reverse-engineering the sheet layout, which is fifteen minutes for codes the demo will never speak. The curated map covers the twenty codes that matter, including every code in both demo slices. Download the xlsx only if an unknown code appears on a demo path.

### `scripts/ingest-incidents.ts`

Calls `loadIncidents()` and prints the `IngestReport`: rows fetched per slice, transformed, duplicates across slices, drops grouped by reason, upserted and modified counts, the call-type family histogram, and any unlabeled codes.

**Assert the final historical count is between 100 and 250 and exit non-zero outside that range.** Below 100 means a slice came back empty, which is almost always the HTTP-200-with-empty-body encoding bug rather than missing data. Above 250 means a `$limit` was raised past its §14 constant.

Print drops rather than dropping silently: `dropped 1 row (1 severity out of range)`. Roughly 311 rows in 30 million carry severity 0 or 9, so the expected count in a 180-row sample is zero or one. A drop count in the dozens means the transform is wrong, not the data.

Flags: `--slice=<name>` to run one slice while iterating on the transform, and `--dry-run` to fetch, transform, and print three sample documents as formatted JSON without writing to Mongo.

Close the Mongo client in a `finally` block; a `tsx` script with an open pool hangs instead of exiting, and somebody will read that as a slow query.

### `scripts/compute-pitch-number.ts`

Socrata aggregates only. No row downloads, no paging.

#### The pitch numbers

Use `$select=count(1) AS n` with a `$where` per metric and read the first row's `n`, falling back to the first value of the returned object if the alias is absent. The count comes back as a string, so cast it.

| Key | `$where` | Expected |
|---|---|---|
| `total_incidents` | none | 29,978,154 |
| `total_2023` | `incident_datetime>'2023-01-01T00:00:00'` | 5,653,498 |
| `divergent_2023` | `incident_datetime>'2023-01-01T00:00:00' AND initial_call_type!=final_call_type` | 845,887 |
| `divergent_all` | `initial_call_type!=final_call_type` | 2,750,007 |
| `undertriage_2023` | `incident_datetime>'2023-01-01T00:00:00' AND final_severity_level_code<initial_severity_level_code` | 400,548 |
| `reopened_all` | `reopen_indicator='Y'` | 237,210 |

Derived percentages:

| Key | Formula | Expected |
|---|---|---|
| `divergent_2023_pct` | `divergent_2023 / total_2023 * 100` | 15.0 |
| `divergent_all_pct` | `divergent_all / total_incidents * 100` | 9.2 |
| `undertriage_2023_pct` | `undertriage_2023 / total_2023 * 100` | 7.1 |
| `reopened_all_pct` | `reopened_all / total_incidents * 100` | 0.79 |

`divergent_2023_pct` is the headline: one in seven New York EMS calls turns out to be something other than what it was dispatched as.

One note on the undertriage comparison. Severity codes arrive as strings, so SoQL compares them as text — but every valid code is a single character, which makes lexicographic and numeric ordering identical. It is correct as written only because the range is 1–8; a multi-digit numeric text column would need an explicit `::number` cast.

`data/pitch-numbers.json`:

| Field | Type | Notes |
|---|---|---|
| `computedAt` | ISO string | When the network call ran. |
| `source` | `string` | `"socrata:76xm-jjuj"`. |
| `metrics[].key` | `string` | From the tables above. |
| `metrics[].where` | `string \| null` | The exact predicate sent, so the number is auditable. |
| `metrics[].value` | `number` | Freshly computed. |
| `metrics[].expected` | `number` | The verified value from the table. |
| `metrics[].drift` | `boolean` | `true` when fresh and expected disagree beyond tolerance. |

**Caching is the point of this script, not an optimization.** Default behavior: if `data/pitch-numbers.json` exists, print from it and make no network request. Refetch only with `--refresh`. A live aggregate over 30 million rows in front of judges is an unforced risk for a number that has not changed, and conference wifi is the most reliable way to lose a pitch. Since `data/` is gitignored the file does not arrive with a clone, so run `npm run pitch -- --refresh` once on the demo machine well before the pitch and add it to the PHASE-15 preflight. Support `--offline` as an explicit alias of the cached path that exits non-zero when the cache is missing, so preflight can state its intent.

Drift handling: tolerance is 0.1 percentage point for percentages and 0.5 percent of the expected value for counts. When a fresh number disagrees, **trust the fresh number**, write it, set `drift: true`, and print a loud block naming the metric, both values, and the instruction that `overview.md`'s metrics table and the pitch slide both need a one-line update. Do not silently overwrite and do not silently keep the old value — the slide and this file must never disagree on stage, and the only way to guarantee that is to make a disagreement impossible to miss. Note it in `agents.md`; editing `overview.md` is a deliberate act, not a side effect of running a script.

#### The reclassification priors

These power the brief line in `reference.png`: "this call type in B3 reclassifies to cardiac 18 percent of the time overnight." The output type is `ReclassPrior` from `contracts.md` §6, written to `data/reclass-priors.json`.

Compute them from a Socrata `$group` on `initial_call_type, incident_dispatch_area, final_call_type` for 2023 onward, **limited to the two demo call types `SICK` and `UNC`**. That is tens of grouped rows, not millions. Deriving them from the ~180 ingested documents instead would give sample sizes of two or three per group, which produces a number that sounds authoritative and means nothing — and this one gets spoken aloud on stage.

| `ReclassPrior` field | Value |
|---|---|
| `initialCallType` | `UNC` or `SICK`. |
| `dispatchArea` | The group's `incident_dispatch_area`, or `null` for the area-agnostic rollup. |
| `nightOnly` | `true` for the night-hours query, `false` for the all-hours query. |
| `sampleSize` | Total incidents in the group. |
| `top` | Up to `topN` (default 3) entries of `{ finalCallType, family, pct, n }` sorted by `pct` descending, where `family` is `callTypeFamily(finalCallType)` and `pct` is `n / sampleSize * 100` rounded to one decimal. |

Emit an area-specific tier and an area-agnostic tier for each call type so PHASE-07 always has something to serve, and suppress any group whose `sampleSize` is below `minSampleSize` (default 8).

For `nightOnly`, run the same grouped query twice: once unrestricted, and once with a `$where` restricting to night hours using SoQL's hour-extraction function on `incident_datetime`. **If that function errors, emit only `nightOnly: false` priors and say so in the report.** The percentage is the load-bearing part of the spoken line; the overnight qualifier is a refinement, and it is not worth ten minutes of SoQL debugging.

Two guardrails on this file. If the group query is slow or returns a 5xx, write priors from whatever grouped rows you did get and mark the shortfall in the report. **Do not invent an 18 percent figure to match the mockup** — that number in `reference.png` is illustrative, and the spoken brief must use a number that came from this file. And these are population-level statistics over historical calls, not the answer to the call in progress: saying that a call type reclassifies to cardiac some percentage of the time overnight reveals nothing about what this patient turns out to have, which is what keeps the brief honest.

`RetrievalPort.reclassPrior` reads this file. PHASE-04 produces it; PHASE-07 serves it.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run ingest:incidents` exits 0 and leaves between 100 and 250 documents with `isLive: false`
- [ ] The script exits non-zero when the resulting count falls outside 100–250
- [ ] Every ingested document has non-empty `incidentId`, `displayId`, `ref`, and `callTypeFamily`, plus `status: "closed"`, `isLive: false`, and `timeline: []`
- [ ] `countDocuments({ isLive: true })` is 0 after ingestion
- [ ] No document carries `final_call_type`, `finalCallType`, `final_severity_level_code`, `incident_close_datetime`, `incident_disposition_code`, `reopen_indicator`, or any `*_seconds_qy` field outside `_groundTruth` — verified by a query, not by reading the code
- [ ] A `find` with `PUBLIC_INCIDENT_PROJECTION` returns documents whose `_groundTruth` is `undefined`
- [ ] Every `cad.initialSeverityLevelCode` and `_groundTruth.finalSeverityLevelCode` is an integer in 1–8
- [ ] `_groundTruth.severityDelta` equals `cad.initialSeverityLevelCode - _groundTruth.finalSeverityLevelCode` for every document
- [ ] `cad.incidentDatetime` is a BSON date, not a string, verified with `$type`
- [ ] At least 20 documents match `cad.initialCallType: "UNC"` with `_groundTruth.finalCallType: "ARREST"`, and at least 20 match `SICK` → `CARD`
- [ ] At least 15 documents have `cad.initialCallType` equal to `_groundTruth.finalCallType`
- [ ] `callTypeFamily` equals `callTypeFamily(cad.initialCallType)` for every document, checked by recomputing it
- [ ] Every row request sends `$order=incident_id` and a `$limit` at or below that slice's §14 constant, and the script never requests `rows.csv` or any `$limit` at or above 1000
- [ ] Query parameters are built with `URLSearchParams`, never a hand-built query string
- [ ] Running `npm run ingest:incidents` twice leaves the count unchanged and every `createdAt` untouched
- [ ] Ingestion succeeds against a database where `npm run indexes` has never run, and creates no indexes itself
- [ ] **Verifiable with all other ports faked:** with every `*_MODE=fake`, `toIncidentDoc` applied to row-shaped entries derived from `fixtures/incidents.json` produces the expected quarantine split with zero network calls and zero API keys
- [ ] `toNum("")` returns `null`; `toInt("0")` and `toInt("9")` cause the row to be dropped with a recorded reason
- [ ] A row with `incident_datetime` of `2024-03-05T01:12:00.000` produces a `ref` beginning `240305` regardless of the machine's timezone
- [ ] `synthesizeUnit` returns the same value for the same `incidentId` across runs and matches `/^\d{1,2}[A-Z]$/`
- [ ] `verifyCodeLabels` returns an empty array, or the run prints the unlabeled codes with counts and the miss is recorded in `agents.md`
- [ ] `npm run pitch` with no cache file writes `data/pitch-numbers.json` containing all ten metrics, using only `count(1)` queries
- [ ] `npm run pitch` with the cache file present makes zero network requests
- [ ] `npm run pitch -- --offline` exits non-zero when the cache file is absent
- [ ] Every metric matches its expected value within tolerance, or the run prints a drift block naming the metric and both values and records `drift: true`
- [ ] `divergent_2023_pct` in the output file is 15.0
- [ ] `data/reclass-priors.json` parses as `ReclassPrior[]`, has at least one entry for `UNC` and one for `SICK`, every `sampleSize` is at least 8, every `top` is sorted by `pct` descending, every `pct` is between 0 and 100, and every `family` equals `callTypeFamily(finalCallType)`
- [ ] Every `pct` in the priors file was computed from a Socrata count, not written as a literal, and no value equals a figure copied from `reference.png`

## Verification

On PowerShell, set inline environment variables with `$env:VAR="value"` before the command instead of the `VAR=value cmd` prefix shown here.

```bash
npm run typecheck

# Transform only, no writes.
EMBEDDINGS_MODE=fake npx tsx scripts/ingest-incidents.ts --slice=arrest --dry-run

# Full ingest, then again to prove idempotency.
EMBEDDINGS_MODE=fake npm run ingest:incidents
EMBEDDINGS_MODE=fake npm run ingest:incidents
```

The quarantine check, which is the criterion that protects Critical Rule 6:

```bash
npx tsx -e "
import { col } from './src/lib/db/client';
import { INCIDENTS, PUBLIC_INCIDENT_PROJECTION, callTypeFamily } from './src/lib/contracts';
const c = col(INCIDENTS);
const n = await c.countDocuments({ isLive: false });
const leak = await c.countDocuments({ \$or: [
  { finalCallType: { \$exists: true } }, { final_call_type: { \$exists: true } },
  { final_severity_level_code: { \$exists: true } }, { reopen_indicator: { \$exists: true } },
  { incident_close_datetime: { \$exists: true } }, { incident_disposition_code: { \$exists: true } },
  { dispatch_response_seconds_qy: { \$exists: true } }, { incident_response_seconds_qy: { \$exists: true } },
]});
const arrest = await c.countDocuments({ 'cad.initialCallType': 'UNC', '_groundTruth.finalCallType': 'ARREST' });
const card = await c.countDocuments({ 'cad.initialCallType': 'SICK', '_groundTruth.finalCallType': 'CARD' });
const control = await c.countDocuments({ \$expr: { \$eq: ['\$cad.initialCallType', '\$_groundTruth.finalCallType'] } });
const dates = await c.countDocuments({ 'cad.incidentDatetime': { \$type: 'date' } });
const sev = await c.countDocuments({ 'cad.initialSeverityLevelCode': { \$gte: 1, \$lte: 8 } });
const live = await c.countDocuments({ isLive: true });
console.log({ n, leak, arrest, card, control, dates, sev, live });
const pub = await c.findOne({}, { projection: PUBLIC_INCIDENT_PROJECTION });
console.log('projection hides groundTruth', (pub as any)?._groundTruth === undefined);
const all = await c.find({}, { projection: { cad: 1, callTypeFamily: 1, _groundTruth: 1 } }).toArray();
console.log('family from initial', all.every((d:any)=>d.callTypeFamily===callTypeFamily(d.cad.initialCallType)));
console.log('delta ok', all.every((d:any)=>d._groundTruth.severityDelta===d.cad.initialSeverityLevelCode-d._groundTruth.finalSeverityLevelCode));
if (n < 100 || n > 250 || leak !== 0 || arrest < 20 || card < 20 || control < 15 || live !== 0 || dates !== n || sev !== n) process.exit(1);
process.exit(0);
"
```

Pure transform functions, no network and no keys:

```bash
EMBEDDINGS_MODE=fake npx tsx -e "
import { toIncidentDoc, toNum, toInt, synthesizeUnit } from './src/lib/ingest/nyc';
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
console.log('family', d.callTypeFamily, 'delta', d._groundTruth?.severityDelta);
console.log('empty seconds -> null', d._groundTruth?.incidentResponseSeconds === null);
console.log('unit stable', synthesizeUnit('16975942') === synthesizeUnit('16975942'), synthesizeUnit('16975942'));
console.log('bad severity dropped', toIncidentDoc({ ...row, initial_severity_level_code: '9' }, { drops }) === null, drops);
process.exit(0);
"
```

The pitch number and the priors:

```bash
rm -f data/pitch-numbers.json      # PowerShell: Remove-Item data/pitch-numbers.json -Force
npm run pitch -- --refresh         # fetches once, writes the cache
npm run pitch                      # must make zero network requests
npm run pitch -- --offline         # prints from cache

npx tsx -e "
import { readFileSync } from 'fs';
import { callTypeFamily } from './src/lib/contracts';
const p = JSON.parse(readFileSync('data/pitch-numbers.json','utf8'));
for (const m of p.metrics) console.log(m.key, m.value, 'expected', m.expected, m.drift ? 'DRIFT' : 'ok');
const h = p.metrics.find((m:any)=>m.key==='divergent_2023_pct');
console.log('headline', h.value, h.value === 15.0 ? 'PASS' : 'CHECK overview.md');
const priors = JSON.parse(readFileSync('data/reclass-priors.json','utf8'));
console.log('entries', priors.length, 'UNC', priors.some((x:any)=>x.initialCallType==='UNC'), 'SICK', priors.some((x:any)=>x.initialCallType==='SICK'));
console.log('sane', priors.every((x:any)=>x.sampleSize>=8 && x.top.every((t:any,i:number)=>
  t.pct>=0 && t.pct<=100 && t.family===callTypeFamily(t.finalCallType) && (i===0||x.top[i-1].pct>=t.pct))));
console.log(JSON.stringify(priors.find((x:any)=>x.initialCallType==='SICK'), null, 2));
process.exit(0);
"
```

## Handoff Note

Announce three things: the ingested document count, whether `verifyCodeLabels` came back empty, and whether any pitch metric drifted. PHASE-06 needs the incident corpus before it can seed memory from it, PHASE-07 needs `data/reclass-priors.json` to implement `reclassPrior`, and PHASE-15 needs to know which number goes on the slide.
