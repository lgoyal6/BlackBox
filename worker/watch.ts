import type { Document } from "mongodb";
import { DECISIONS, INCIDENTS, POSTMORTEMS, REMEDIATIONS } from "@/lib/contracts";
import { col, getDb } from "@/lib/db/client";
import { loadResumeToken, saveResumeToken } from "./state";
import { onLiveIncident, onMemoryWrite } from "./trigger";

export interface WorkerWatcher {
  close(): Promise<void>;
}

const MEMORY_COLLECTIONS = [DECISIONS, POSTMORTEMS, REMEDIATIONS];

/**
 * A missing namespace makes `watch` hang or throw depending on the server, and a hung worker
 * looks exactly like a running one — which is a hung demo. Fail loudly and immediately instead.
 */
async function requireCollection(name: string): Promise<void> {
  const found = await getDb().listCollections({ name }, { nameOnly: true }).toArray();
  if (found.length === 0) {
    console.error(`MISSING COLLECTION ${name} — run PHASE-02's index/validator setup first`);
    process.exit(1);
  }
}

function makeCloser(
  name: string,
  stream: { close(): Promise<void> },
): WorkerWatcher {
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      try {
        await stream.close();
      } catch {
        // Idempotent; a double close must not throw.
      }
      console.log(`[worker] cursor closed (${name})`);
    },
  };
}

/** Change stream on `incidents`, filtered to live inserts. Historical seed inserts start nothing. */
export async function watchIncidents(): Promise<WorkerWatcher> {
  await requireCollection(INCIDENTS);

  const token = await loadResumeToken("watch:incidents");
  const stream = col<Document>(INCIDENTS).watch(
    // No `fullDocument: "updateLookup"` — inserts already carry the full document.
    [{ $match: { operationType: "insert", "fullDocument.isLive": true } }],
    token ? { resumeAfter: token as Document } : {},
  );

  stream.on("change", (change: unknown) => {
    void (async () => {
      const c = change as {
        _id?: unknown;
        fullDocument?: { incidentId?: string; isLive?: boolean };
      };
      const doc = c.fullDocument;
      // The pipeline already excludes historical rows; guard again rather than trust it.
      if (!doc?.incidentId || doc.isLive !== true) return;
      await onLiveIncident(doc.incidentId);
      // After the handler, never before.
      if (c._id !== undefined) await saveResumeToken("watch:incidents", c._id);
    })();
  });

  stream.on("error", (err: unknown) => {
    console.error(
      `[worker] incidents cursor error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return makeCloser("incidents", stream);
}

/**
 * One database-level change stream across the three memory collections rather than three
 * collection cursors, so SIGINT closes one extra cursor instead of three.
 */
export async function watchWrites(): Promise<WorkerWatcher> {
  const token = await loadResumeToken("watch:writes");
  const stream = getDb().watch(
    [
      {
        $match: {
          operationType: "insert",
          "ns.coll": { $in: MEMORY_COLLECTIONS },
        },
      },
    ],
    token ? { resumeAfter: token as Document } : {},
  );

  stream.on("change", (change: unknown) => {
    void (async () => {
      const c = change as { _id?: unknown; ns?: { coll?: string } };
      const collection = c.ns?.coll;
      if (!collection) return;
      // Absolute total, per `onMemoryWrite`. One countDocuments per insert is free on
      // collections holding single digits during a demo.
      const count = await col<Document>(collection).countDocuments({});
      await onMemoryWrite(collection, count);
      if (c._id !== undefined) await saveResumeToken("watch:writes", c._id);
    })();
  });

  stream.on("error", (err: unknown) => {
    console.error(
      `[worker] writes cursor error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return makeCloser("writes", stream);
}
