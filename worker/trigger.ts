import { events, graph } from "@/lib/registry";

/** Fires the graph at a newly inserted live incident. */
export async function onLiveIncident(incidentId: string): Promise<void> {
  try {
    await (await graph()).start(incidentId);
    console.log(`[worker] start ${incidentId}`);
  } catch (err) {
    // A bad graph must not kill the cursor — the worker outlives any single run.
    console.error(
      `GRAPH START FAILED ${incidentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Emits the dashboard's write counter for a memory collection.
 *
 * `incidentId` is null because a write counter is global on the dashboard; PHASE-10's
 * `recent(id)` includes `incidentId: null` events for exactly this reason.
 *
 * `count` is the collection's absolute total, never a delta. PHASE-14 treats it as the total
 * and applies last-write-wins, because a delta would double-count on every browser reload when
 * the 200-event replay re-delivers the same write events. Sending `1` per insert would leave
 * the counter reading `1` for the whole demo, and those counters are the numbers the presenter
 * points at.
 */
export async function onMemoryWrite(collection: string, count: number): Promise<void> {
  await (await events()).emit({
    kind: "write",
    incidentId: null,
    payload: { collection, count },
  });
}
