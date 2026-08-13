# Phase 12 — Change Stream Worker

**Status:** PENDING
**Tasks:** US-023
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 25 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Run a long-lived process, separate from the Next.js app, that watches Atlas and starts a graph run when a live incident appears. Persist a resume token so an incident inserted while the worker is down is processed after restart. Ship a `TRIGGER_MODE=poll` fallback that is timeboxed to thirty minutes of implementation, not a second architecture.

## Why This Cannot Be A Route Handler

A Next.js App Router handler is request-scoped. A change stream cursor has to stay open for the life of the process. Putting the trigger in a route handler means it dies on the first deploy, the first hot reload, and the first serverless freeze. The worker is therefore `tsx worker/index.ts` via the already-registered `npm run worker` script.

MongoDB is the coordination. The worker inserts nothing into a queue and talks to the Next app through no IPC: it calls `GraphPort.start` and `EventsPort.emit`. The dashboard sees those writes because PHASE-10's SSE route is watching the same `events` collection.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §2 — `INCIDENTS`, `DECISIONS`, `REMEDIATIONS`, `POSTMORTEMS`, `WATCH_STATE`. Never hardcode a collection string.
- `.ralph/contracts.md` §5 — `IncidentDoc.isLive`. The trigger filter is `isLive: true` plus `operationType: "insert"`. Historical seed inserts must not start a graph.
- `.ralph/contracts.md` §8 — `write` events. The second watcher emits these so the dashboard counters move.
- `.ralph/contracts.md` §9 — `GraphPort.start`, `EventsPort.emit`. Resolve both through `@/lib/registry`.
- `.ralph/overview.md` — Runtime processes table, Cut List item 2 (polling is the allowed degradation), file ownership (`worker/**` only).
- `.ralph/specs/phase-10-event-bus-sse.md` — PHASE-10 writes `_watch_state` documents whose `_id` is prefixed `seq:`. This phase uses `watch:` and `poll:` only. **Never `deleteMany({})` on `_watch_state`.**
- `src/lib/db/client.ts` — `getClient()`, `col()`. Do not construct a second `MongoClient`.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `worker/index.ts` | Process entry: mode select, signal handlers, logging |
| `worker/state.ts` | Resume-token and poll-watermark helpers on `_watch_state` |
| `worker/watch.ts` | Change-stream trigger + write-event watcher |
| `worker/poll.ts` | `TRIGGER_MODE=poll` fallback |
| `worker/trigger.ts` | Shared `onLiveIncident` / `onMemoryWrite` handlers |

`package.json` already has `"worker": "tsx worker/index.ts"`. Do not edit it. Do not create files under `app/` or `src/lib/`.

### Ports consumed

| Port | Used for | Set this to build in isolation |
|---|---|---|
| `GraphPort` | `start(incidentId)` on a new live incident | `GRAPH_MODE=fake` |
| `EventsPort` | `write` events from the memory-collection watcher | `EVENTS_MODE=fake` |

Build and verify with:

```
TRIGGER_MODE=changestream
GRAPH_MODE=fake EVENTS_MODE=fake
EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake LLM_MODE=fake VOICE_MODE=fake
```

The fake graph records `start` calls and walks `GRAPH_NODE_ORDER`. That is enough to prove the worker fired. The fake events port appends to an in-memory array with `__drain()` for assertions when the worker and the assertion share a process; for the real `npm run worker` process, assert by reading the `events` collection or the worker log line.

This phase needs a replica set for `TRIGGER_MODE=changestream` (Atlas is one). PHASE-01's `npm run check` already asserts that. If `watch()` throws because the target is not a replica set, log `TRIGGER POLL FALLBACK` and switch to poll for this process only — do not silently hang.

### Ports implemented

None.

## Files to Create

### `worker/state.ts`

```ts
export type WatchKey = "watch:incidents" | "watch:writes";
export type PollKey = "poll:incidents";

export async function loadResumeToken(key: WatchKey): Promise<unknown | null>;
export async function saveResumeToken(key: WatchKey, token: unknown): Promise<void>;
export async function loadPollWatermark(key: PollKey): Promise<Date>;
export async function savePollWatermark(key: PollKey, at: Date): Promise<void>;
```

Documents in `col(WATCH_STATE)`:

| `_id` | Fields | Owner |
|---|---|---|
| `watch:incidents` | `resumeToken`, `updatedAt` | this phase |
| `watch:writes` | `resumeToken`, `updatedAt` | this phase |
| `poll:incidents` | `lastSeen`, `updatedAt` | this phase |
| `seq:*` | `value` | PHASE-10 — **do not read or write** |

`saveResumeToken` is a single `updateOne({ _id }, { $set: { resumeToken, updatedAt: new Date() } }, { upsert: true })`. Persist **after** the event is handled, not before. Saving first and then crashing on `graph().start` would skip the incident forever.

`loadPollWatermark` returns `new Date(0)` when the document is missing so the first poll pass considers recent inserts rather than the entire historical seed. On that first pass, still filter `isLive: true` so 180 historical rows do not each start a graph.

### `worker/trigger.ts`

```ts
export async function onLiveIncident(incidentId: string): Promise<void>;
export async function onMemoryWrite(collection: string, count: number): Promise<void>;
```

`onLiveIncident` calls `(await graph()).start(incidentId)` and logs `[worker] start <incidentId>`. Catch, log `GRAPH START FAILED <incidentId>`, and return — a bad graph must not kill the cursor. Do not call `start` for `isLive: false` documents; the pipeline filter should have already excluded them, but guard again.

`onMemoryWrite` emits `{ kind: "write", incidentId: null, payload: { collection, count } }`. `incidentId` is null because a write counter is global on the dashboard. PHASE-10's `recent(id)` includes `incidentId: null` events for this reason.

**`count` is the collection's absolute total, not a delta — call `col(collection).countDocuments({})` and send that.** PHASE-14's reducer treats `count` as the total for that bucket and applies last-write-wins, because a delta would double-count on every browser reload when the 200-event replay re-delivers the same write events. Sending `1` per insert leaves the counter reading `1` for the whole demo, and those counters are the numbers the presenter points at. An absolute value is also self-healing: a missed event costs one frame instead of a permanently wrong number. One `countDocuments` per insert is free on collections that hold single digits during a demo.

### `worker/watch.ts`

```ts
export interface WorkerWatcher {
  close(): Promise<void>;
}

export async function watchIncidents(): Promise<WorkerWatcher>;
export async function watchWrites(): Promise<WorkerWatcher>;
```

**Incidents cursor.** `col(INCIDENTS).watch(pipeline, options)`:

```ts
const pipeline = [
  { $match: { operationType: "insert", "fullDocument.isLive": true } },
];
const token = await loadResumeToken("watch:incidents");
const options = token ? { resumeAfter: token } : {};
```

On each change: read `fullDocument.incidentId`, call `onLiveIncident`, then `saveResumeToken("watch:incidents", change._id)`. The resume token is `change._id` (the token object), not the document's `_id`.

**Writes cursor.** One stream on `DECISIONS` is not enough — also see `POSTMORTEMS` and `REMEDIATIONS`. Open a single `db.watch` with:

```ts
{ $match: {
  operationType: "insert",
  "ns.coll": { $in: [DECISIONS, POSTMORTEMS, REMEDIATIONS] },
}}
```

or three collection watches that share `onMemoryWrite`. Prefer one `getDb().watch(...)` so SIGINT closes one extra cursor rather than three. Read the collection name from `change.ns.coll` and pass `await col(change.ns.coll).countDocuments({})` as the count — the absolute total, per `onMemoryWrite` above. Persist under `watch:writes`.

**Do not pass `fullDocument: "updateLookup"`.** Inserts already carry `fullDocument`.

`close()` must be idempotent. Log `[worker] cursor closed (<name>)` so the leak check is greppable.

If the namespace is missing (PHASE-02 has not created `incidents` yet), `watch` can hang or throw depending on the server. Catch, log a line containing `MISSING COLLECTION` and the collection name, and **exit 1**. Do not retry forever — that looks like a running worker and is a hung demo.

### `worker/poll.ts`

Timebox implementation of this file to **30 minutes**. If change streams work, this is the parachute from the cut list, not a second product. A `find` every 1000 ms is enough.

```ts
export async function startPoller(): Promise<{ stop(): void }>;
```

Each tick:

1. Load `poll:incidents` watermark.
2. `find({ isLive: true, createdAt: { $gt: watermark } }).sort({ createdAt: 1 })`.
3. For each row, `onLiveIncident` then advance the watermark to that row's `createdAt`.
4. If zero rows, still save `new Date()` only after the first successful empty tick so a later insert is seen; do not skip the first-pass `Date(0)` behavior described above.

US-023 requires the graph to fire **within 3 seconds** of an insert under `TRIGGER_MODE=poll`. A 1000 ms interval plus handler time meets that. Do not add backoff that can exceed 3 seconds.

Also emit write events on poll? Not required. The write watcher is change-stream-only; under poll mode the dashboard counters update on the next tool-route emit. Do not spend the timebox building a second poller for three collections.

### `worker/index.ts`

```ts
async function main(): Promise<void>;
```

1. Read `TRIGGER_MODE` (`changestream` | `poll`). Default `changestream`.
2. Log `[worker] trigger=<mode>` as the first line so `npm run preflight` can grep it.
3. If `changestream`, open both watchers. If `watchIncidents` throws, log `TRIGGER POLL FALLBACK` and start the poller instead.
4. If `poll`, start only the poller.
5. On `SIGINT` and `SIGTERM`: close cursors / stop the poller, `getClient().close()`, log `[worker] exit`, `process.exit(0)`.
6. Hold the process open. A `tsx` script that returns from `main` without an open handle will exit; the cursors are that handle. For poll, keep the interval.

Do not start a Next server. Do not import `app/**`.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run worker` starts and the first log line contains `trigger=changestream` or `trigger=poll`
- [ ] With `TRIGGER_MODE=changestream` and `GRAPH_MODE=fake`, inserting one `{ isLive: true, incidentId }` document into `incidents` causes a log line `[worker] start <incidentId>` and no polling loop is running (no `poll:` watermark updates)
- [ ] Inserting an `isLive: false` (historical) incident does **not** call `graph().start`
- [ ] A second watcher emits a `write` event when a document is inserted into `decisions`, `postmortems`, or `remediations`
- [ ] That `write` event's `count` equals the collection's current `countDocuments({})`, not `1` — insert two decisions and confirm the second event reports `2`, because PHASE-14 renders `count` as an absolute total
- [ ] The resume token is written to `_watch_state` under `watch:incidents` after each handled event
- [ ] An `isLive: true` incident inserted while the worker is stopped is processed after restart, proving `resumeAfter` (or the poll watermark) works — do not rely on "it was still in the oplog by luck" without a persisted token
- [ ] `TRIGGER_MODE=poll` fires `graph().start` within 3 seconds of an insert
- [ ] A missing `incidents` collection logs `MISSING COLLECTION` and the process exits non-zero rather than hanging
- [ ] SIGINT closes both cursors (or the poller) and the process exits 0; a second SIGINT is not required
- [ ] `_watch_state` documents this phase writes are only `watch:*` and `poll:*`; `rg -n "seq:" worker` returns nothing
- [ ] **Verifiable with all other ports faked:** `GRAPH_MODE=fake EVENTS_MODE=fake` plus the remaining modes `fake`
- [ ] No file was created or modified outside `worker/**`
- [ ] Poll fallback implementation stayed inside the 30-minute timebox — a 1000 ms `find` loop, not a custom queue

## Verification

```bash
npm run typecheck

# Terminal 1
TRIGGER_MODE=changestream GRAPH_MODE=fake EVENTS_MODE=fake \
  EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake LLM_MODE=fake VOICE_MODE=fake \
  npm run worker
# expect: [worker] trigger=changestream
```

```bash
# Terminal 2 — live insert should start the fake graph
npx tsx -e "
import { col } from './src/lib/db/client';
import { INCIDENTS } from './src/lib/contracts';
const id = 'live-worker-' + Date.now();
await col(INCIDENTS).insertOne({
  incidentId: id, displayId: '0001', ref: '260813-0001',
  status: 'dispatched', isLive: true, timeline: [],
  cad: { initialCallType: 'UNC', initialSeverityLevelCode: 2, borough: 'BROOKLYN',
         zipcode: '11201', dispatchArea: 'B3', incidentDatetime: new Date() },
  callTypeFamily: 'altered', createdAt: new Date(), updatedAt: new Date(),
});
console.log('inserted', id);
process.exit(0);
"
# worker log must show [worker] start live-worker-...
```

Resume-token drill:

```bash
# stop the worker (Ctrl-C), insert another isLive incident, start the worker again
# expect [worker] start <that id> without inserting a second time
```

Poll path:

```bash
TRIGGER_MODE=poll GRAPH_MODE=fake EVENTS_MODE=fake npm run worker
# insert an isLive incident; [worker] start must appear within 3 seconds
```

```bash
# SIGINT: Ctrl-C once; process must exit. Then:
rg -n "seq:" worker
```

## Handoff Note

PHASE-11's `POST /api/demo/fire` inserts the live incident this worker watches. PHASE-08's `GraphPort.start` is what actually runs the graph; with the fake, the worker is still doing its job if the log line appears. PHASE-16 smoke assumes the worker is running in `changestream` mode unless the operator set `TRIGGER_MODE=poll`.
