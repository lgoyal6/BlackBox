import type { Document } from "mongodb";
import {
  CHECKPOINTS,
  CHECKPOINT_WRITES,
  DECISIONS,
  DemoResetReq,
  EVENTS,
  INCIDENTS,
  POSTMORTEMS,
  REMEDIATIONS,
  RUNBOOKS,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The delete list is closed. Anything not on it survives.
 *
 * `decisions` is emptied wholesale because the collection is live-only by Critical Rule 5;
 * postmortems and remediations are filtered to `origin: "live"` so the seeded and curated
 * corpus stays put. Re-embedding the seed corpus twenty minutes before the pitch is a
 * self-inflicted wound.
 */
const DELETIONS: { collection: string; filter: Document }[] = [
  { collection: DECISIONS, filter: {} },
  { collection: POSTMORTEMS, filter: { origin: "live" } },
  { collection: REMEDIATIONS, filter: { origin: "live" } },
  { collection: EVENTS, filter: {} },
  { collection: CHECKPOINTS, filter: {} },
  { collection: CHECKPOINT_WRITES, filter: {} },
  { collection: INCIDENTS, filter: { isLive: true } },
];

/** The three floors that must not move. Measured before and after; a drop is a 500, not a shrug. */
async function seedFloors(): Promise<{ postmortems: number; runbooks: number; incidents: number }> {
  const [postmortems, runbooks, incidents] = await Promise.all([
    col<Document>(POSTMORTEMS).countDocuments({ origin: { $in: ["seeded", "curated"] } }),
    col<Document>(RUNBOOKS).countDocuments({}),
    col<Document>(INCIDENTS).countDocuments({ isLive: false }),
  ]);
  return { postmortems, runbooks, incidents };
}

/** `POST /api/demo/reset` — delete the live residue of a rehearsal and nothing else. */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    const raw = await req.text();
    body = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const parsed = DemoResetReq.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  try {
    const before = await seedFloors();

    const deleted: Record<string, number> = {};
    for (const { collection, filter } of DELETIONS) {
      const res = await col<Document>(collection).deleteMany(filter);
      deleted[collection] = res.deletedCount ?? 0;
    }

    // `_watch_state` is deliberately absent from DELETIONS: PHASE-10 keeps `seq:*` counters
    // there and PHASE-12 keeps `watch:*` / `poll:*` resume tokens. Clearing them looks
    // convenient and breaks both streams. `_embed_cache` is absent for the same reason.

    const after = await seedFloors();
    if (
      after.postmortems < before.postmortems ||
      after.runbooks < before.runbooks ||
      after.incidents < before.incidents
    ) {
      throw new Error(
        `reset ate the seed corpus: postmortems ${before.postmortems}→${after.postmortems}, ` +
          `runbooks ${before.runbooks}→${after.runbooks}, ` +
          `historical incidents ${before.incidents}→${after.incidents}`,
      );
    }

    return Response.json({ deleted }, { status: 200 });
  } catch (err) {
    // Do not swallow a bad filter — PHASE-15 and PHASE-16 both assert the floors survive.
    console.error(`[demo] reset failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
