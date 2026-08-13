import type { Document } from "mongodb";
import { EVENTS, type BlackboxEvent } from "@/lib/contracts";
import type { EventsPort } from "@/lib/ports";
import { col } from "@/lib/db/client";
import { nextSeq } from "./seq";

const DEFAULT_RECENT = 200;

/**
 * Maps a raw driver document onto a `BlackboxEvent`, turning the `ObjectId` into a string
 * (`EventBase._id` is typed `string | undefined`).
 *
 * Replayed and live frames both go through this, so the two are byte-identical in the browser.
 * If they diverge, PHASE-14 ends up with two render paths and one of them is the buggy one.
 */
export function normalizeEvent(doc: Document): BlackboxEvent {
  const { _id, ...rest } = doc;
  return {
    ...rest,
    _id: _id === null || _id === undefined ? undefined : String(_id),
  } as unknown as BlackboxEvent;
}

/**
 * Appends one event to the bus: allocates `seq`, stamps `t` as a real `Date`, inserts.
 *
 * Never rejects. Callers are voice tool handlers on a 300 ms budget and LangGraph nodes
 * mid-run; the bus is observability, and an observability write must not fail a voice turn or
 * abort a graph node on stage. Failures log a line starting `EVENT EMIT FAILED`, so one grep
 * answers "is the bus actually writing" instead of this quietly hiding a real bug.
 */
export async function emit(e: Omit<BlackboxEvent, "seq" | "t" | "_id">): Promise<void> {
  try {
    const seq = await nextSeq(e.incidentId);
    await col<Document>(EVENTS).insertOne({ ...e, seq, t: new Date() });
  } catch (err) {
    console.error(
      `EVENT EMIT FAILED kind=${e.kind} incidentId=${e.incidentId ?? "null"}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * The newest `n` events, returned in ascending chronological order.
 *
 * Sorted descending then reversed in memory: an ascending sort with a limit returns the
 * *first* n documents in the collection, so after twenty minutes of rehearsal the dashboard
 * would replay the start of the session and then jump.
 *
 * Events with `incidentId: null` are always included. `write` counters and `checkpoint` counts
 * carry no incident, and filtering them out would hide the live counters from the very screen
 * they exist for.
 *
 * PHASE-14: because global events have their own independent counter, a client watching one
 * incident sees **two interleaved `seq` series**. Gap detection must be keyed on each event's
 * own `incidentId`, never on a single global last-seen number.
 */
export async function recent(
  incidentId: string | null,
  n: number = DEFAULT_RECENT,
): Promise<BlackboxEvent[]> {
  const filter: Document = incidentId ? { incidentId: { $in: [incidentId, null] } } : {};
  const rows = await col<Document>(EVENTS)
    .find(filter)
    .sort({ t: -1, seq: -1 })
    .limit(n)
    .toArray();
  return rows.reverse().map(normalizeEvent);
}

const eventsAdapter: EventsPort = { emit, recent };
const _check: EventsPort = eventsAdapter;
void _check;

export default eventsAdapter;
