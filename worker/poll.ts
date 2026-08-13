import type { Document } from "mongodb";
import { INCIDENTS } from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { loadPollWatermark, savePollWatermark } from "./state";
import { onLiveIncident } from "./trigger";

/**
 * Cut-list item 2: polling is the allowed degradation when change streams are unavailable.
 * US-023 wants the graph firing within 3 seconds of an insert, so 1000 ms plus handler time
 * clears it. No backoff — backoff here can exceed the 3-second budget.
 */
const TICK_MS = 1_000;

export async function startPoller(): Promise<{ stop(): void }> {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const watermark = await loadPollWatermark("poll:incidents");
      const rows = await col<Document>(INCIDENTS)
        .find({ isLive: true, createdAt: { $gt: watermark } })
        .sort({ createdAt: 1 })
        .toArray();

      for (const row of rows) {
        const incidentId = typeof row.incidentId === "string" ? row.incidentId : null;
        if (incidentId) await onLiveIncident(incidentId);
        if (row.createdAt instanceof Date) {
          await savePollWatermark("poll:incidents", row.createdAt);
        }
      }
    } catch (err) {
      console.error(
        `[worker] poll tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
