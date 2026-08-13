import { WATCH_STATE } from "@/lib/contracts";
import { col } from "@/lib/db/client";

export type WatchKey = "watch:incidents" | "watch:writes";
export type PollKey = "poll:incidents";

/**
 * `_watch_state` is shared with PHASE-10, which owns every sequence-counter document. This phase touches
 * only `watch:*` and `poll:*`. **Never `deleteMany({})` on this collection** — that is also why
 * `POST /api/demo/reset` deliberately leaves it alone.
 */
type WatchStateDoc = {
  _id: string;
  resumeToken?: unknown;
  lastSeen?: Date;
  updatedAt?: Date;
};

function states() {
  return col<WatchStateDoc>(WATCH_STATE);
}

export async function loadResumeToken(key: WatchKey): Promise<unknown | null> {
  const doc = await states().findOne({ _id: key });
  return doc?.resumeToken ?? null;
}

/**
 * Persist **after** the event is handled, never before. Saving first and then crashing in
 * `graph().start` would skip that incident forever.
 */
export async function saveResumeToken(key: WatchKey, token: unknown): Promise<void> {
  await states().updateOne(
    { _id: key },
    { $set: { resumeToken: token, updatedAt: new Date() } },
    { upsert: true },
  );
}

/**
 * Missing document returns the epoch so the first poll pass considers recent inserts rather
 * than nothing at all. The `isLive: true` filter is what stops 180 historical rows from each
 * starting a graph on that first pass.
 */
export async function loadPollWatermark(key: PollKey): Promise<Date> {
  const doc = await states().findOne({ _id: key });
  return doc?.lastSeen instanceof Date ? doc.lastSeen : new Date(0);
}

export async function savePollWatermark(key: PollKey, at: Date): Promise<void> {
  await states().updateOne(
    { _id: key },
    { $set: { lastSeen: at, updatedAt: new Date() } },
    { upsert: true },
  );
}
