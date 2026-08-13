import type { BlackboxEvent } from "@/lib/contracts";
// `@/lib/events` is an ambient module declaration (`src/lib/real-ports.d.ts`) exposing only the
// default export the registry loads, so the named import goes through the concrete file path.
import { recent } from "@/lib/events/index";
import { watchEvents, type EventWatcher } from "@/lib/events/watch";

// The Mongo driver cannot run on the edge runtime.
export const runtime = "nodejs";
// A statically analyzed or cached route handler will not hold a stream open, and the failure
// mode is a connection that returns immediately with an empty body — which reads like a
// dashboard bug rather than a caching decision.
export const dynamic = "force-dynamic";

const ENCODER = new TextEncoder();
const REPLAY_LIMIT = 200;
const HEARTBEAT_MS = 15_000;
const POLL_FALLBACK_MS = 1_000;

/** `GET /api/events?incidentId=<id>` — Server-Sent Events driven by an Atlas change stream. */
export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("incidentId");
  if (raw !== null && raw.trim() === "") {
    // Deliberately not a 400: PHASE-16's smoke issues `GET /api/events?incidentId=` while
    // probing the replay. Warn so a genuine dashboard bug is still visible.
    console.warn("[events] empty incidentId parameter — streaming all events");
  }
  const incidentId = raw !== null && raw.trim() !== "" ? raw.trim() : null;

  let watcher: EventWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let torndown = false;

  // A leaked change stream per browser reload exhausts the Atlas connection pool during
  // rehearsal, and it presents as Atlas refusing connections across the whole app — the
  // worker stops, ingestion stops, the graph stops. Nothing in that picture points here.
  const teardown = async (): Promise<void> => {
    if (torndown) return;
    torndown = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
    try {
      await watcher?.close();
    } catch {
      // Teardown runs from two places; running twice must be harmless.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stop = async (): Promise<void> => {
        await teardown();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      // Fires when the browser navigates away or the tab closes. The stream's cancel()
      // callback below covers the consumer-releases-the-stream case.
      req.signal.addEventListener("abort", () => void stop());

      const write = (chunk: string): void => {
        if (torndown) return;
        try {
          controller.enqueue(ENCODER.encode(chunk));
        } catch {
          void stop();
        }
      };

      const sent = new Set<string>();
      const keyOf = (e: BlackboxEvent): string =>
        e._id ?? `${e.incidentId ?? "__global__"}:${e.seq}`;

      // One `data:` line carrying the whole event object and no `event:` name. A named SSE
      // event needs an addEventListener per name, so adding an event `kind` later would
      // silently drop frames in a dashboard written before it existed.
      const frameOf = (e: BlackboxEvent): string => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;

      let dropped = 0;
      /**
       * Slow clients get dropped, never awaited. A backgrounded tab that stops reading its
       * socket would otherwise back-pressure the change stream cursor and through it the
       * process doing the insert — the LangGraph run. A stalled tab must not slow the graph.
       */
      const push = (e: BlackboxEvent, force = false): void => {
        const key = keyOf(e);
        if (sent.has(key)) return;
        if (!force) {
          const room = controller.desiredSize;
          if (room !== null && room <= 0) {
            dropped += 1;
            if (dropped === 1 || dropped % 100 === 0) {
              console.warn(`[events] dropped ${dropped}`);
            }
            return;
          }
        }
        sent.add(key);
        write(frameOf(e));
      };

      let live = false;
      const buffered: BlackboxEvent[] = [];

      // The parachute, not the story: a change stream problem degrades the dashboard's
      // latency instead of blanking it.
      const startPollFallback = (reason: unknown): void => {
        if (torndown || poller) return;
        console.warn(
          `SSE POLL FALLBACK — change stream unavailable, polling every ${POLL_FALLBACK_MS}ms: ${
            reason instanceof Error ? reason.message : String(reason)
          }`,
        );
        poller = setInterval(() => {
          void (async () => {
            try {
              for (const e of await recent(incidentId, REPLAY_LIMIT)) push(e);
            } catch (err) {
              console.error(
                `[events] poll fallback read failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          })();
        }, POLL_FALLBACK_MS);
      };

      // Open the change stream BEFORE the replay find(). The other order leaves a window
      // between the snapshot and the subscription in which an event is lost forever — and the
      // events most likely to land in it are the ones fired by the operator's click a
      // half-second before the dashboard finished loading. Live events that arrive during the
      // replay are buffered and flushed, deduplicated by `sent`.
      try {
        watcher = await watchEvents({
          incidentId,
          onEvent: (e) => {
            if (live) push(e);
            else buffered.push(e);
          },
          onError: (err) => {
            watcher = null;
            startPollFallback(err);
          },
        });
      } catch (err) {
        startPollFallback(err);
      }

      // Replay boundary uses SSE *comments*, which every client ignores, rather than a
      // synthetic event kind: the union in contracts.md §8 is closed and PHASE-14 switches on
      // it exhaustively. n individual frames bracketed by comments, never one frame holding
      // an array, so the browser has exactly one parsing path.
      let replay: BlackboxEvent[] = [];
      try {
        replay = await recent(incidentId, REPLAY_LIMIT);
      } catch (err) {
        console.error(
          `[events] replay failed, streaming live only: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      write(`: replay ${replay.length}\n\n`);
      // Replay frames enqueue unconditionally: bounded at 200 and the stream starts empty.
      for (const e of replay) push(e, true);

      // Flush and flip to live in the same tick, with no await between, so nothing slips through.
      for (const e of buffered) push(e, true);
      buffered.length = 0;
      live = true;
      write(`: live\n\n`);

      // Not optional. Idle proxies and tunnels close a connection with no bytes on it, and
      // the demo runs ElevenLabs tool traffic through an ngrok tunnel.
      heartbeat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);
    },

    cancel() {
      void teardown();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      // `no-transform` stops a proxy gzipping the stream, which buffers it.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx-family proxies buffer response bodies by default and the stream appears frozen.
      "X-Accel-Buffering": "no",
    },
  });
}
