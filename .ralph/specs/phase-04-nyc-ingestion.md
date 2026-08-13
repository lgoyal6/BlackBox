# Phase 04 — NYC Dispatch Ingestion and the Pitch Number

**Status:** PENDING
**Tasks:** US-007, US-008
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 25 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Pull a **small demo slice** of real NYC EMS incidents into `incidents` with the answers stripped, and compute the city-wide pitch number via Socrata `COUNT` aggregates that never download a row.

## Demo scale (locked — do not enlarge)

This is a hackathon, not a warehouse. Constants live in `contracts.md` §14. Four SODA requests, about 180 documents:

| Slice | Filter | Limit |
|---|---|---|
| `arrest` | `UNC` → `ARREST`, 2024+ | 40 |
| `cardiac` | `SICK` → `CARD`, 2024+ | 40 |
| `divergent` | any mismatch, 2024+ | 80 |
| `control` | match, 2024+ | 20 |

**Never download the bulk CSV** (`rows.csv?accessType=DOWNLOAD` is several gigabytes and will eat the afternoon). **Never raise `$limit` past the constants.** **Never page.** One request per slice is enough.

The 15.0% headline is a different query: four `$select=count(1)` aggregates against the full city dataset. Those return one number each. That is how you get a city-wide statistic without a city-wide download.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §5 (`IncidentDoc`, `CadFields`, `GroundTruth`, `PUBLIC_INCIDENT_PROJECTION`), §4 (`callTypeFamily`, `labelFor`, `CODE_LABELS`), §14 (`DEMO_SLICES`, `SOCRATA_BASE`)
- `.ralph/overview.md` — Critical Rule 6, verified Socrata facts
- `fixtures/incidents.json` — shape to match when testing offline

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `src/lib/ingest/nyc.ts` | Fetch, transform, upsert |
| `scripts/ingest-incidents.ts` | CLI, wired to `npm run ingest:incidents` |
| `scripts/compute-pitch-number.ts` | CLI, wired to `npm run pitch` |

Do not edit `package.json`. Do not add to `CODE_LABELS` (PHASE-01 owns it) — report missing labels instead.

### Ports consumed

None required. Ingestion does not embed. Pitch numbers hit Socrata, not Atlas Vector Search.

Optional: if you want to write reclass priors through a helper that later PHASE-07 reads, still just write `data/reclass-priors.json` as JSON. Do not import `@/lib/retrieval`.

### Ports implemented

None.

## Verified Socrata facts (2026-08-13 — do not re-derive)

- Endpoint `https://data.cityofnewyork.us/resource/76xm-jjuj.json`, no auth. Send `X-App-Token` when `SOCRATA_APP_TOKEN` is set.
- JSON keys are **lowercase snake_case**. Identifier is **`incident_id`, not `CAD_INCIDENT_ID`**. Every value arrives as a **string**.
- `final_call_type` is never null across 29,978,154 rows, so `!=` needs no null guard.
- Severity: lower code = more severe; valid 1–8; drop 0 and 9.
- Paging without `$order` is non-deterministic. Always send `$order=incident_id` even though we do not page.
- Unencoded spaces in `$where` return an **empty body with HTTP 200**. Pass params through `URLSearchParams`. Never hand-build the query string.

## Files to Create

### `src/lib/ingest/nyc.ts`

```ts
export function fetchSlice(slice: (typeof DEMO_SLICES)[number]): Promise<SocrataRow[]>;
export function toIncidentDoc(row: SocrataRow): IncidentDoc | null;  // null = drop (bad severity)
export function loadIncidents(): Promise<IngestReport>;
export function computePitchNumbers(): Promise<PitchNumbers>;
export function computeReclassPriors(): Promise<ReclassPrior[]>;
```

`toIncidentDoc` must:

1. Cast severity codes to `int`, return `null` outside 1–8.
2. Parse `*_datetime` strings to UTC `Date` (they arrive naive).
3. Cast `*_seconds_qy` to number; empty string → `null`.
4. Put dispatch-time fields in `cad`. Synthesize `cad.unit` (e.g. `"14B"`) — the dataset has no unit field and `reference.png` displays one.
5. Move `final_call_type`, `final_severity_level_code`, `incident_close_datetime`, `incident_disposition_code`, `reopen_indicator`, and every response-time field into `_groundTruth`. Compute `severityDelta = initial - final`.
6. Set `isLive: false`, `status: "closed"`, `timeline: []`, `displayId` via `toDisplayId`, `ref` via `toRef`, `callTypeFamily` via `callTypeFamily`.

Upsert on `incidentId`. Re-runs must not grow the count.

After load, print any `cad.initialCallType` that `labelFor` cannot expand from `CODE_LABELS`. Do not parse the xlsx attachment unless an unknown code actually appears — that is 15 minutes for codes the demo will never speak.

### `scripts/ingest-incidents.ts`

Calls `loadIncidents()`, prints a report: fetched, inserted, updated, dropped-for-severity, family histogram. Asserts total historical count is between 100 and 250 — outside that range, a slice limit was changed or a query returned empty (the 200-with-empty-body bug).

### `scripts/compute-pitch-number.ts`

Four (plus reopen) Socrata **count** queries, cached to `data/pitch-numbers.json`. Expected ballpark, already verified:

| Metric | Expected |
|---|---|
| Total incidents | 29,978,154 |
| 2023+ call-type change | 845,887 / 5,653,498 = 15.0% |
| All-time call-type change | 2,750,007 = 9.2% |
| 2023+ undertriage (`final_severity < initial_severity`) | 400,548 = 7.1% |
| Reopened | 237,210 = 0.79% |

If a fresh run disagrees, **trust the fresh number**, write it, and print a warning that `overview.md` needs a one-line update. The slide and this file must never disagree on stage.

Also write `data/reclass-priors.json` from a Socrata `$group` on `initial_call_type, incident_dispatch_area` for 2023+, **limited to the two demo call types `SICK` and `UNC`**, top final types with percentages. That is tens of grouped rows, not millions. PHASE-07 reads this file through `RetrievalPort.reclassPrior`. If the group query is slow or 500s, write a fixture prior for `SICK` / a B-series dispatch area from whatever grouped rows you did get, and mark it in the report — do not invent an 18% figure to match `reference.png`. The mockup's "18%" is illustrative; the spoken brief must use a number that came from this file.

Cache hits skip the network. **Never call Socrata during the demo.** Conference wifi is the most reliable way to lose a pitch.

## Acceptance Criteria

- [ ] `npm run ingest:incidents` inserts between 100 and 250 historical documents
- [ ] At least 20 documents match `cad.initialCallType: "UNC"` with `_groundTruth.finalCallType: "ARREST"`
- [ ] At least 20 documents match `cad.initialCallType: "SICK"` with `_groundTruth.finalCallType: "CARD"`
- [ ] No document has a top-level `finalCallType`, `finalSeverityLevelCode`, or `incidentCloseDatetime`
- [ ] Every `cad.initialSeverityLevelCode` is an integer 1–8
- [ ] Every `cad.incidentDatetime` is a `Date`, not a string
- [ ] Every document has `displayId`, `ref`, `callTypeFamily`, and `isLive: false`
- [ ] Every Socrata row request sends `$order=incident_id` and a `$limit` ≤ the §14 constant for that slice
- [ ] Query parameters are encoded by `URLSearchParams`, never a hand-built query string
- [ ] Re-running leaves the document count unchanged
- [ ] The script never requests `rows.csv` or a `$limit` ≥ 1000
- [ ] `npm run pitch` writes `data/pitch-numbers.json` with the five metrics, using only `count(1)` / `$group` queries
- [ ] A second `npm run pitch` does not hit the network
- [ ] `data/reclass-priors.json` exists and every `pct` in it was computed from a Socrata count, not a literal
- [ ] `npm run typecheck` passes

## Verification

```bash
npm run ingest:incidents
npm run ingest:incidents    # count must not grow
npm run pitch
npx tsx -e "
import { col } from './src/lib/db/client';
import { INCIDENTS } from './src/lib/contracts';
const c = col(INCIDENTS);
const n = await c.countDocuments({ isLive: false });
const leak = await c.countDocuments({ finalCallType: { \$exists: true } });
const arrest = await c.countDocuments({ 'cad.initialCallType': 'UNC', '_groundTruth.finalCallType': 'ARREST' });
const card = await c.countDocuments({ 'cad.initialCallType': 'SICK', '_groundTruth.finalCallType': 'CARD' });
console.log({ n, leak, arrest, card });
if (n < 100 || n > 250 || leak !== 0 || arrest < 20 || card < 20) process.exit(1);
"
```
