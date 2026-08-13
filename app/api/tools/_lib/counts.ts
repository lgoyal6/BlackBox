import type { Document } from "mongodb";
import { col } from "@/lib/db/client";

/**
 * Absolute document count for a collection, used to fill `write.payload.count`.
 *
 * `count` is a total, never a delta: PHASE-14 applies last-write-wins so the 200-event SSE
 * replay stays idempotent, and an absolute value is self-healing — a missed event costs one
 * frame instead of a permanently wrong number.
 *
 * Reads only. Every `decisions` and `postmortems` *write* in this phase goes through
 * `MemoryPort`; nothing here inserts.
 *
 * Returns 0 rather than throwing: this feeds an event emit, which must never fail a voice turn.
 */
export async function countIn(collection: string): Promise<number> {
  try {
    return await col<Document>(collection).countDocuments({});
  } catch (err) {
    console.error(
      `[tool] count failed for ${collection}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
