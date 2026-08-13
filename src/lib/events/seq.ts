import { WATCH_STATE } from "@/lib/contracts";
import { col } from "@/lib/db/client";

/** `_watch_state` documents this phase owns. String `_id`, so the collection is typed here. */
type SeqDoc = { _id: string; value: number };

/**
 * `_watch_state` is deliberately shared. PHASE-10 owns `seq:*` and nothing else; PHASE-12 owns
 * `watch:*` and `poll:*`. Never issue `deleteMany({})` against this collection from either
 * side, and `POST /api/demo/reset` leaves it alone for the same reason.
 */
export function seqKey(incidentId: string | null): string {
  return `seq:${incidentId ?? "__global__"}`;
}

/**
 * Atomically allocates and returns the next sequence number for this incident. First call
 * returns 1.
 *
 * One server-side `$inc` on a single document, never a count of existing documents. Two emits
 * landing in the same millisecond — normal, because `record_decision` emits a `decision` event
 * while the worker emits a `write` event for the same insert — would both read n and both
 * write n+1. That is a duplicate seq plus a permanent hole, and `EventBase.seq` is documented
 * monotonic, so the client would report a dropped event that never happened.
 */
export async function nextSeq(incidentId: string | null): Promise<number> {
  const res = await col<SeqDoc>(WATCH_STATE).findOneAndUpdate(
    { _id: seqKey(incidentId) },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return typeof res?.value === "number" ? res.value : 1;
}
