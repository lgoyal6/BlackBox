import { env } from "@/lib/env";
import { getClient } from "@/lib/db/client";
import { startPoller } from "./poll";
import { watchIncidents, watchWrites, type WorkerWatcher } from "./watch";

/**
 * The trigger cannot live in a route handler: an App Router handler is request-scoped and a
 * change stream cursor has to stay open for the life of the process, so it would die on the
 * first deploy, the first hot reload, and the first serverless freeze.
 *
 * There is no queue and no IPC. The worker calls `GraphPort.start` and `EventsPort.emit`, and
 * the dashboard sees the result because PHASE-10's SSE route watches the same `events`
 * collection. MongoDB is the coordination.
 */
async function main(): Promise<void> {
  const mode = env.triggerMode.toLowerCase() === "poll" ? "poll" : "changestream";
  // First line, so `npm run preflight` can grep it.
  console.log(`[worker] trigger=${mode}`);

  const watchers: WorkerWatcher[] = [];
  let poller: { stop(): void } | null = null;

  if (mode === "changestream") {
    try {
      watchers.push(await watchIncidents());
      watchers.push(await watchWrites());
    } catch (err) {
      // Realistic cause: the target is not a replica set. Degrade rather than hang silently.
      console.warn(
        `TRIGGER POLL FALLBACK — change streams unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      for (const w of watchers) await w.close();
      watchers.length = 0;
      poller = await startPoller();
    }
  } else {
    poller = await startPoller();
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    // One SIGINT is enough; a second must not be required.
    if (shuttingDown) return;
    shuttingDown = true;
    poller?.stop();
    for (const w of watchers) await w.close();
    try {
      await getClient().close();
    } catch {
      // Nothing left to close.
    }
    console.log("[worker] exit");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // The open cursors are the handle that holds the process; the poll interval is the
  // equivalent under `TRIGGER_MODE=poll`. Returning from main() without one would exit.
}

main().catch((err: unknown) => {
  console.error(`[worker] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
