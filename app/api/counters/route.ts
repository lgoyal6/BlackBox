import type { Document } from "mongodb";
import {
  CHECKPOINTS,
  DECISIONS,
  EVENTS,
  INCIDENTS,
  POSTMORTEMS,
  REMEDIATIONS,
  RUNBOOKS,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { embeddings } from "@/lib/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COUNTED = [INCIDENTS, DECISIONS, REMEDIATIONS, RUNBOOKS, POSTMORTEMS, EVENTS, CHECKPOINTS];

/** `GET /api/counters` — collection totals plus the embedding provider actually in use. */
export async function GET(): Promise<Response> {
  try {
    const counts: Record<string, number> = {};
    await Promise.all(
      COUNTED.map(async (name) => {
        counts[name] = await col<Document>(name).countDocuments({});
      }),
    );

    // Under EMBEDDINGS_MODE=fake this reports the fake's info, which is correct and expected.
    const embedding = (await embeddings()).info();

    return Response.json(
      { counts, checkpointCount: counts[CHECKPOINTS] ?? 0, embedding },
      { status: 200 },
    );
  } catch (err) {
    console.error(`[counters] failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
