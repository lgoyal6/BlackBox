import { useEffect, useReducer, useRef, useState } from "react";
import type { BlackboxEvent } from "@/lib/contracts";
import { createFixturePlayer, loadFixtureEvents } from "./fixture-source";
import { EMPTY_VIEW, parseEvent, reduceAll, reduceEvent, type DashboardView } from "./view-state";

export type ConnectionState = "idle" | "fixture" | "connecting" | "open" | "reconnecting";

export interface EventStreamOptions {
  incidentId: string | null;
  mode: "real" | "fixture";
  replay: boolean;
}

export interface EventStreamResult {
  view: DashboardView;
  connection: ConnectionState;
  reconnectAttempts: number;
  lastEventAtMs: number | null;
}

/** 1s, 2s, 4s, 8s, then a jittered 10s ceiling. Never gives up. */
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const BACKOFF_CEILING_MS = 10_000;

function backoffFor(attempt: number): number {
  const base = attempt < BACKOFF_MS.length ? BACKOFF_MS[attempt] : BACKOFF_CEILING_MS;
  return base + Math.floor(Math.random() * 400);
}

/**
 * Counter bootstrap arrives as synthetic events in their own dedupe bucket, so the
 * reducer stays the single place event data is applied and nothing special-cases it.
 */
function bootstrapEvents(payload: unknown): BlackboxEvent[] {
  if (typeof payload !== "object" || payload === null) return [];
  const o = payload as Record<string, unknown>;
  const out: BlackboxEvent[] = [];
  let seq = 1;
  const t = new Date();

  const counts = o.counts;
  if (typeof counts === "object" && counts !== null) {
    for (const [collection, count] of Object.entries(counts as Record<string, unknown>)) {
      if (typeof count !== "number") continue;
      out.push({
        seq: seq++,
        incidentId: "__bootstrap",
        t,
        kind: "write",
        payload: { collection, count },
      });
    }
  }

  if (typeof o.checkpointCount === "number") {
    out.push({
      seq: seq++,
      incidentId: "__bootstrap",
      t,
      kind: "checkpoint",
      payload: { count: o.checkpointCount },
    });
  }

  return out;
}

export function useEventStream(o: EventStreamOptions): EventStreamResult {
  const { incidentId, mode, replay } = o;

  // At speed 0 the fixture is applied during initialisation rather than in an effect, so
  // the reference state renders server-side and a reload on stage never shows an empty
  // frame. The clock is anchored to the newest event, so this hydrates deterministically.
  const [view, dispatch] = useReducer(reduceEvent, undefined, () =>
    mode === "fixture" && !replay ? reduceAll(loadFixtureEvents()) : EMPTY_VIEW,
  );
  const [connection, setConnection] = useState<ConnectionState>(
    mode === "fixture" ? "fixture" : "idle",
  );
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [lastEventAtMs, setLastEventAtMs] = useState<number | null>(null);

  // Read inside the reconnect handler without making it a dependency.
  const gapCountRef = useRef(view.gapCount);
  gapCountRef.current = view.gapCount;

  useEffect(() => {
    if (mode !== "fixture") return;

    setConnection("fixture");
    // speed 0 was already applied at init; only the paced rehearsal replay needs a player.
    if (!replay) return;

    const player = createFixturePlayer({
      events: loadFixtureEvents(),
      speed: 1,
      onEvent: (e) => {
        dispatch(e);
        setLastEventAtMs(Date.now());
      },
    });
    player.start();
    return () => player.stop();
  }, [mode, replay]);

  useEffect(() => {
    if (mode !== "real") return;
    if (typeof window === "undefined") return;

    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let cancelled = false;

    async function bootstrapCounters(): Promise<void> {
      try {
        const res = await fetch("/api/counters", { cache: "no-store" });
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (cancelled) return;
        for (const e of bootstrapEvents(body)) dispatch(e);
      } catch {
        // The stream is the primary source; a missing bootstrap is not fatal.
      }
    }

    function connect(): void {
      if (cancelled) return;
      setConnection(attempt === 0 ? "connecting" : "reconnecting");

      const url =
        incidentId === null
          ? "/api/events"
          : `/api/events?incidentId=${encodeURIComponent(incidentId)}`;
      const es = new EventSource(url);
      source = es;

      es.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setConnection("open");
      };

      es.onmessage = (m: MessageEvent) => {
        if (cancelled) return;
        const parsed = parseEvent(safeJson(m.data));
        if (parsed === null) return;
        // Never clears the view: dedupe by seq makes re-applying the replay frame a no-op.
        dispatch(parsed);
        setLastEventAtMs(Date.now());
      };

      es.onerror = () => {
        if (cancelled) return;
        // EventSource's built-in retry does not cover every failure mode and gives no
        // attempt count to display, so close and re-create explicitly.
        es.close();
        source = null;

        const before = gapCountRef.current;
        const wait = backoffFor(attempt);
        attempt += 1;
        setReconnectAttempts(attempt);
        setConnection("reconnecting");

        timer = setTimeout(() => {
          // A missed `write` would otherwise leave a counter wrong for the rest of the
          // call; re-reading the totals is a cheap and complete repair.
          if (before > 0) void bootstrapCounters();
          connect();
        }, wait);
      };
    }

    void bootstrapCounters().then(() => {
      if (!cancelled) connect();
    });

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      if (source !== null) source.close();
    };
  }, [mode, incidentId]);

  return { view, connection, reconnectAttempts, lastEventAtMs };
}

function safeJson(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
