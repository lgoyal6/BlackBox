# Phase 10 — Event Bus and SSE Stream

**Status:** PENDING
**Tasks:** US-019, US-020
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 30 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Make MongoDB the event bus: implement `EventsPort` so any process can append a `BlackboxEvent` to the `events` collection, and serve those events to the browser over Server-Sent Events driven by an Atlas change stream, with replay on connect so a browser refresh never blanks the judge-facing screen.

## Why SSE Over a Change Stream, and Not WebSocket

Next.js App Router route handlers cannot upgrade to WebSocket without a custom server, and a custom server means giving up Turbopack dev ergonomics on a day when nobody has time for that. Route handlers **can** return a long-lived `ReadableStream`, which is exactly Server-Sent Events, and the dashboard is one-directional anyway.

That constraint turns into a genuine advantage: **MongoDB is the transport.** Any process — a route handler, the worker, a `tsx` script — inserts into the `events` collection; this phase's SSE route opens a change stream on `events` and pushes each one to the browser. The consequences are all in this project's favor:

- **Replay after a browser reload is a plain `find()`.** There is no in-memory ring buffer to lose on hot reload, and no state that lives in one Node process.
- **Multi-process coordination is free.** PHASE-12's worker runs in a separate process from the Next app and needs no IPC — it inserts, the SSE route notices.
- **It honors the hackathon's central constraint literally.** MongoDB is the memory, the state, the context, **and the transport.** No Redis, no broker.

When a judge asks whether the dashboard is real, the answer is that every number on it arrives via an Atlas change stream.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §8 — the `BlackboxEvent` discriminated union. Implement the shapes exactly; PHASE-14 switches on `kind` exhaustively and any extra or renamed variant breaks it.
- `.ralph/contracts.md` §9 — `EventsPort` (`emit`, `recent`) and the registry rule that the real module default-exports at a fixed path.
- `.ralph/contracts.md` §10 — the `GET /api/events` header list and the replay + heartbeat requirement.
- `.ralph/contracts.md` §2 — `EVENTS`, `WATCH_STATE` collection name constants. Never hardcode a collection string.
- `.ralph/overview.md` — Architecture (event bus rationale), file ownership table, Critical Rule 1.
- `fixtures/event-stream.json` — roughly 40 real events covering every `kind`. This is the corpus this phase is verified against and the same file PHASE-14 renders `reference.png` from, so if an event from this file does not survive a round trip through `emit` → change stream → SSE frame, the dashboard will be wrong on stage.
- `src/lib/db/client.ts` (PHASE-01) — use `col(EVENTS)`; do not construct a `MongoClient`.

## Parallel-Safe Contract

### Files this phase owns

From the ownership table in `overview.md`, PHASE-10 owns exactly:

- `src/lib/events/**`
- `app/api/events/route.ts`

Create nothing outside those two paths. In particular: **do not create indexes here.** The TTL index on `events.t` and any supporting index belong to PHASE-02 (`src/lib/db/indexes.ts`). Change streams need no index at all, and `recent()` is a bounded query over a collection that TTLs at 24 hours, so it is fast enough without one on hackathon data volumes.

### Ports consumed, and how to build with zero dependencies

This phase consumes **no ports.** It reads and writes `events` through `col()` and nothing else, which is why it is the cheapest phase to verify in isolation. Its only external dependency is a live Atlas connection with a replica set, which change streams require and which PHASE-01's `npm run check` already asserts.

Build and verify it with every other port faked so nothing can silently pull in another phase's work:

```
EVENTS_MODE=real
EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake LLM_MODE=fake GRAPH_MODE=fake VOICE_MODE=fake
```

`EVENTS_MODE=real` is the point: it makes the registry resolve *this* phase's module instead of `fakes/events`, so the absence of a `FAKE PORT` warning for events is itself a passing check.

### Port implemented

PHASE-10 implements `EventsPort`. Per the registry rules in `contracts.md` §9, it must **default-export an object satisfying `EventsPort` from exactly `src/lib/events/index.ts`** (registry path `@/lib/events`). The registry resolves that path as a static string literal and never gets edited, so the default export at that exact path is the entire integration contract. A named export instead of a default, or the object living in `src/lib/events/events.ts` with no re-export, produces a silent fall back to the fake — which looks like a working dashboard right up until nothing appears on it.

## Files to Create

### `src/lib/events/seq.ts`

`EventBase.seq` is documented as **monotonic per incident** so the client can detect a gap. That word does the work: the client is allowed to conclude that a missing number means a lost event, so the allocation has to be genuinely gap-free and duplicate-free under concurrency.

```ts
/** `seq:<incidentId>`, or `seq:__global__` when incidentId is null. */
export function seqKey(incidentId: string | null): string;

/** Atomically allocates and returns the next sequence number for this incident. First call returns 1. */
export async function nextSeq(incidentId: string | null): Promise<number>;
```

Implement `nextSeq` as a single `findOneAndUpdate` on `col(WATCH_STATE)` with `{ $inc: { value: 1 } }`, `upsert: true`, `returnDocument: "after"`, and return the resulting `value`.

**Do not count existing documents to derive the next number.** Two `emit` calls landing in the same millisecond — which is normal, because `record_decision` emits a `decision` event while the worker emits a `write` event for the same insert — would both read *n* and both write *n+1*. That produces a duplicate seq and a permanent hole, and the client, doing exactly what the contract invites it to do, reports a dropped event that never happened. `$inc` is applied server-side on a single document, so it is atomic for free.

Two notes on the storage location:

- The counter lives in `_watch_state` because that collection already exists in `contracts.md` §2 and is the natural home for stream bookkeeping. **PHASE-12 also writes to `_watch_state`** for its resume tokens, under `_id` values prefixed `watch:` and `poll:`. Namespace every `_id` this phase writes with `seq:` and **never issue `deleteMany({})` against `_watch_state`** — clearing it would reset both phases' bookkeeping.
- Counters are per incident and every live incident gets a fresh `incidentId` from `POST /api/demo/fire`, so counters never need resetting between rehearsal runs. That is also why `POST /api/demo/reset` (PHASE-11) deliberately leaves `_watch_state` alone.

### `src/lib/events/index.ts`

The `EventsPort` implementation and the default export the registry loads.

```ts
import type { BlackboxEvent, EventsPort } from "@/lib/ports";

export async function emit(e: Omit<BlackboxEvent, "seq" | "t" | "_id">): Promise<void>;
export async function recent(incidentId: string | null, n?: number): Promise<BlackboxEvent[]>;

const eventsAdapter: EventsPort = { emit, recent };
export default eventsAdapter;
```

**`emit`** assigns `seq` from `nextSeq(e.incidentId)`, sets `t` to `new Date()` (a real `Date`, never an ISO string — `contracts.md` §13), and inserts one document into `col(EVENTS)`.

**`emit` must resolve even when the insert fails.** Catch, log a single line beginning `EVENT EMIT FAILED`, and return. The reason is a priority ordering, not laziness: the callers are voice tool handlers on a 300 ms budget and LangGraph nodes mid-run. The event bus is observability, and an observability write must never fail a voice turn or abort a graph node on stage. The distinctive log prefix is what keeps this from hiding a real bug — one `grep` answers "is the bus actually writing".

**`recent`** returns the last `n` events (default 200) in **ascending chronological order**:

| Concern | Requirement |
|---|---|
| Filter, `incidentId` given | `{ incidentId: { $in: [incidentId, null] } }` |
| Filter, `incidentId === null` | `{}` — every event, for a dashboard that boots before an incident exists |
| Sort | `{ t: -1, seq: -1 }`, `limit(n)`, then **reverse in memory** |
| `_id` | Map the driver's `ObjectId` to a string; `EventBase._id` is typed `string \| undefined` |

Sorting descending and reversing is deliberate. An ascending sort with a limit returns the *first* n events in the collection, which after twenty minutes of rehearsal is the wrong end — the dashboard would replay the start of the session and then jump.

The `$in: [incidentId, null]` filter is also deliberate. Some events legitimately carry `incidentId: null`, notably `write` events for a collection whose document has no incident (PHASE-12) and `checkpoint` counts. Filtering strictly by incident would make the live write counters invisible on the very screen they exist for.

One consequence to hand to PHASE-14: because global events have their own independent counter, **a client watching one incident sees two interleaved `seq` series.** Gap detection must be keyed on the event's own `incidentId`, not on a single global last-seen number. Say this in a comment above `recent` so the dashboard author reads it.

### `src/lib/events/watch.ts`

The change stream wrapper, kept separate from the port so the SSE route can own the stream lifecycle explicitly rather than inheriting it from a module singleton.

```ts
export interface EventWatcher {
  close(): Promise<void>;
}

export interface WatchOptions {
  incidentId: string | null;
  onEvent: (e: BlackboxEvent) => void;
  onError: (err: unknown) => void;
}

export async function watchEvents(opts: WatchOptions): Promise<EventWatcher>;

/** Number of change streams this process currently holds open. Used by the leak check. */
export function openStreamCount(): number;
```

Implementation requirements:

- Open with `col(EVENTS).watch(pipeline)` where the pipeline is `[{ $match: { operationType: "insert", ...(incidentId ? { "fullDocument.incidentId": { $in: [incidentId, null] } } : {}) } }]`. Matching server-side means a busy rehearsal with two incidents does not ship every event to every tab.
- **Do not pass `fullDocument: "updateLookup"`.** Insert events already carry the full document, and this phase only watches inserts. The extra lookup is a second round trip per event for nothing.
- Map each `change.fullDocument` through the same `_id`-to-string normalization `recent` uses, so a replayed event and a live event are byte-identical in the browser. If they differ, PHASE-14 will end up with two code paths and one of them will be the buggy one.
- Increment `openStreamCount` on open and decrement in `close`, and log `[events] change stream closed (open=<n>)` on every close. That one line is what makes the leak acceptance criterion checkable without a profiler.
- `close()` must be idempotent — it gets called from both the abort handler and the stream's `cancel` callback, and a double `cursor.close()` should not throw.

### `app/api/events/route.ts`

The SSE endpoint: `GET /api/events?incidentId=<id>`.

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response>;
```

`runtime = "nodejs"` because the Mongo driver cannot run on the edge runtime. `dynamic = "force-dynamic"` because a statically analyzed or cached route handler will not hold a stream open, and the failure mode is a connection that returns immediately with an empty body — which reads like a dashboard bug rather than a caching decision.

**Query parameter.** `incidentId` is optional; absent means stream everything. Present-but-empty is a `400` with `{ error: "incidentId must be non-empty" }`, because a dashboard bug that produces `?incidentId=` should surface as an error rather than silently switching to the firehose.

**Response headers, exactly:**

| Header | Value | Why |
|---|---|---|
| `Content-Type` | `text/event-stream` | |
| `Cache-Control` | `no-cache, no-transform` | `no-transform` stops a proxy from gzipping the stream, which buffers it |
| `Connection` | `keep-alive` | |
| `X-Accel-Buffering` | `no` | nginx-family proxies buffer response bodies by default and the stream appears frozen |

**Frame format.** One frame per event:

```
id: <seq>
data: <JSON.stringify(event)>

```

Use `data:` with the whole event object and **no `event:` name.** A named SSE event requires the client to `addEventListener` per name, so adding an event `kind` later would silently drop frames in a dashboard written before it existed. One `message` channel carrying the discriminated union means PHASE-14 switches on `payload.kind` in one place, the same way it does for a replayed event.

**Do not invent a synthetic event kind to mark the replay boundary.** The union in `contracts.md` §8 is closed and PHASE-14 switches on it exhaustively. Use SSE **comments**, which every client ignores: write `: replay <n>\n\n` before the replayed batch and `: live\n\n` after it. This resolves the one ambiguity in the contract's wording — "first frame is a replay of the last 200 events" is implemented as *n* individual frames bracketed by comments, not one frame containing an array, so the browser has exactly one parsing path.

**Startup ordering.** Open the change stream **before** running the replay `find()`, buffer live events that arrive during the replay, then flush the buffer, skipping any `_id` already sent. Doing it the other way around leaves a window between the snapshot and the subscription in which an event is lost forever — and the events most likely to land in that window are the ones fired by the operator's click a half-second before the dashboard finished loading. If you are short on time, the cheap version is to open the stream first and accept a possible duplicate, deduplicated by a `Set` of sent `_id` strings; that is a few lines and is what the acceptance criterion checks.

**Heartbeat.** A `setInterval` every **15 seconds** writing `: ping\n\n`. This is not optional. Idle proxies and tunnels close a connection with no bytes on it, and the demo runs the ElevenLabs tool traffic through an ngrok tunnel, so this will happen. Clear the interval in every teardown path or the timer keeps a reference to a closed controller and every enqueue throws.

**Cleanup on disconnect — the highest-consequence detail in this phase.** Register teardown in **both** places:

- `req.signal.addEventListener("abort", teardown)` — fires when the browser navigates away or the tab closes.
- The `ReadableStream`'s `cancel()` callback — fires when the consumer releases the stream.

They fire in different situations, and teardown must be idempotent so running twice is harmless. Teardown closes the change stream, clears the heartbeat interval, and closes the controller inside a `try`/`catch`.

A leaked change stream per browser reload will exhaust the Atlas connection pool during rehearsal, and **the failure presents as Atlas refusing connections across the entire app** — the worker stops, ingestion stops, the graph stops. Nothing in that picture points at the dashboard, so an hour disappears into the wrong file.

**Slow clients get dropped, never awaited.** Before enqueuing a live event, check `controller.desiredSize`; if it is non-null and `<= 0`, drop the event, increment a counter, and log `[events] dropped <n>` at most once per 100 drops. Never `await` a write to relieve back pressure. A backgrounded browser tab that stops reading its socket would otherwise back-pressure the change stream cursor, and through it the process doing the insert — which is the LangGraph run. A stalled tab must not be able to slow the graph. Replay frames may be enqueued unconditionally; they are bounded at 200 and the stream starts empty.

**Automatic poll fallback (write it after the primary path works).** If `watchEvents` throws on startup — the realistic cause is a target that is not a replica set — fall back to polling `recent()` every 1000 ms, tracking the highest `(t, seq)` already sent, and log a warning containing `SSE POLL FALLBACK`. Roughly ten lines, no new env var, and it means a change stream problem degrades the dashboard's latency instead of blanking it. The change stream stays the story you tell a judge; this is the parachute.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds
- [ ] `src/lib/events/index.ts` has a **default export** and `const _check: EventsPort = eventsAdapter;` compiles — a type-level assertion, not an assumption
- [ ] With `EVENTS_MODE=real`, `(await events())` from `@/lib/registry` returns this module and the startup log contains **no** `FAKE PORT` warning for events
- [ ] 200 concurrent `emit` calls for one `incidentId` produce exactly the sequence 1..200: 200 documents, 200 distinct `seq` values, min 1, max 200
- [ ] `emit` **resolves** (does not reject) when `MONGODB_URI` is unreachable, and the process logs a line containing `EVENT EMIT FAILED` and exits 0
- [ ] `recent(id, 5)` returns 5 events in ascending `seq` order after 40 have been emitted, and returns the *newest* 5, not the oldest
- [ ] `recent(id)` includes events emitted with `incidentId: null`
- [ ] Every event `_id` returned by `recent` is a `string`, not an `ObjectId`
- [ ] **Verifiable with all other ports faked:** with `EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake LLM_MODE=fake GRAPH_MODE=fake VOICE_MODE=fake`, emitting all events from `fixtures/event-stream.json` and then connecting to `/api/events?incidentId=<id>` replays exactly that count of `data:` frames, and each frame parses as a `BlackboxEvent` with a `kind` present in the `contracts.md` §8 union
- [ ] `curl -i` against the route returns all four headers from the table with those exact values
- [ ] A `: ping` comment appears in the stream within 16 seconds of connecting with no other traffic
- [ ] An event inserted into `events` by a **separate process** (a `tsx` one-liner, not the Next app) appears in an already-open SSE stream within 2 seconds
- [ ] Replay and live frames for the same event are byte-identical apart from arrival order
- [ ] After 5 connect-then-disconnect cycles, the last `[events] change stream closed` line in the server log reports `open=0`
- [ ] A client that stops reading does not stall a second client: with one stalled connection open, a second `curl` still receives new events, and the server log contains `[events] dropped`
- [ ] `?incidentId=` (empty) returns `400` with `{ error: ... }`
- [ ] No file was created or modified outside `src/lib/events/**` and `app/api/events/route.ts`

## Verification

PowerShell note: set env vars with `$env:VAR="value"` on a preceding line; the inline `VAR=value cmd` form below is bash-only.

```bash
npm run typecheck
npm run build
```

Sequence allocation under concurrency — the race this phase is most likely to get wrong:

```bash
npx tsx -e "
import ev from './src/lib/events/index';
const id = 'seqtest-' + Date.now();
await Promise.all(Array.from({length:200}, (_,i) =>
  ev.emit({ kind:'write', incidentId:id, payload:{ collection:'decisions', count:i } })));
const rows = await ev.recent(id, 500);
const seqs = rows.map(r => r.seq).sort((a,b) => a-b);
console.log('rows', rows.length, 'unique', new Set(seqs).size, 'min', seqs[0], 'max', seqs.at(-1));
console.log('ids are strings', rows.every(r => typeof r._id === 'string'));
process.exit(0);
"
```

Expect `rows 200 unique 200 min 1 max 200` and `true`.

`emit` never rejects when the database is gone:

```bash
MONGODB_URI="mongodb+srv://bad:bad@nonexistent.invalid/?serverSelectionTimeoutMS=2000" npx tsx -e "
import ev from './src/lib/events/index';
await ev.emit({ kind:'checkpoint', incidentId:null, payload:{ count: 1 } });
console.log('emit resolved');
process.exit(0);
"
```

Load the fixture corpus, then read the stream. Run the dev server in one terminal:

```bash
EVENTS_MODE=real EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake LLM_MODE=fake \
  GRAPH_MODE=fake VOICE_MODE=fake npm run dev
```

In a second terminal:

```bash
INC=fixture-$(date +%s)

npx tsx -e "
import { readFileSync } from 'fs';
import ev from './src/lib/events/index';
const id = process.env.INC!;
const all = JSON.parse(readFileSync('fixtures/event-stream.json','utf8'));
for (const e of all) await ev.emit({ ...e, seq: undefined, t: undefined, _id: undefined, incidentId: id });
console.log('emitted', all.length);
process.exit(0);
"

curl -sN -D - "http://localhost:3000/api/events?incidentId=$INC" | head -c 4000
```

Expect the four headers, a `: replay <n>` comment, *n* `data:` frames matching the fixture count, a `: live` comment, and then a `: ping` roughly 15 seconds later.

Cross-process liveness — insert from a script while the stream is open:

```bash
curl -sN "http://localhost:3000/api/events?incidentId=$INC" &
sleep 2
npx tsx -e "
import ev from './src/lib/events/index';
await ev.emit({ kind:'node', incidentId: process.env.INC!, payload:{ node:'brief', phase:'enter' } });
process.exit(0);
"
```

The frame must appear in the backgrounded `curl` within 2 seconds. Then check the header values and the leak count:

```bash
curl -si "http://localhost:3000/api/events?incidentId=$INC" | head -n 12
for i in 1 2 3 4 5; do curl -sN --max-time 2 "http://localhost:3000/api/events?incidentId=$INC" > /dev/null; done
```

The dev server log's last `[events] change stream closed` line must read `open=0`.

## Handoff Note

Two facts other phases need the moment this passes. PHASE-14: the frame format is one `data:` line per event with the full object, replay is bracketed by `: replay`/`: live` comments, and gap detection is per-`incidentId` because global events carry their own `seq` series. PHASE-11 and PHASE-12: `emit` never throws, so you do not need to wrap it, and it is safe to call on a latency-budgeted path.
