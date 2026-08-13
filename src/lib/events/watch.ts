import type { Document } from "mongodb";
import { EVENTS, type BlackboxEvent } from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { normalizeEvent } from "./index";

export interface EventWatcher {
  close(): Promise<void>;
}

export interface WatchOptions {
  incidentId: string | null;
  onEvent: (e: BlackboxEvent) => void;
  onError: (err: unknown) => void;
}

/**
 * How long to wait for an immediate change-stream failure before declaring the watcher open.
 * A target that is not a replica set errors within a few milliseconds, so this is short enough
 * to stay off the dashboard's connect path and long enough to catch the real failure.
 */
const EARLY_ERROR_WINDOW_MS = 250;

let openStreams = 0;

/** Number of change streams this process currently holds open. Used by the leak check. */
export function openStreamCount(): number {
  return openStreams;
}

/**
 * Opens a change stream on `events`, filtered server-side so a busy rehearsal with two
 * incidents does not ship every event to every tab.
 *
 * Rejects if the stream fails to start — the realistic cause is a target that is not a replica
 * set — so the caller can fall back to polling instead of serving a silent stream.
 */
export async function watchEvents(opts: WatchOptions): Promise<EventWatcher> {
  const match: Document = { operationType: "insert" };
  if (opts.incidentId) {
    match["fullDocument.incidentId"] = { $in: [opts.incidentId, null] };
  }

  // No `fullDocument: "updateLookup"`: inserts already carry the full document and this
  // stream watches only inserts, so the lookup would be a second round trip per event.
  const stream = col<Document>(EVENTS).watch([{ $match: match }]);
  openStreams += 1;

  let closed = false;
  const close = async (): Promise<void> => {
    // Idempotent — called from both the abort handler and the stream's cancel callback.
    if (closed) return;
    closed = true;
    openStreams = Math.max(0, openStreams - 1);
    try {
      await stream.close();
    } catch {
      // A double close must not throw.
    }
    console.log(`[events] change stream closed (open=${openStreams})`);
  };

  let settled = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      resolve();
    }, EARLY_ERROR_WINDOW_MS);

    stream.once("error", (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void close();
      reject(err);
    });
  });

  stream.on("change", (change: unknown) => {
    const c = change as { operationType?: string; fullDocument?: Document };
    if (c.operationType !== "insert" || !c.fullDocument) return;
    try {
      opts.onEvent(normalizeEvent(c.fullDocument));
    } catch (err) {
      opts.onError(err);
    }
  });

  stream.on("error", (err: unknown) => {
    opts.onError(err);
    void close();
  });

  return { close };
}
