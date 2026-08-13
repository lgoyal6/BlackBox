import type { BlackboxEvent } from "@/lib/contracts";
import { parseEvent } from "./view-state";
// Static import, never a fetch: fixtures/ is not public/, and bundling the fixture at
// build time is exactly what makes fixture mode survive a dead network on stage.
import raw from "../../fixtures/event-stream.json";

export interface FixturePlayerOptions {
  events: readonly BlackboxEvent[];
  /** 0 applies every event synchronously (the reference state). 1 spaces them 250ms apart. */
  speed: 0 | 1;
  onEvent: (e: BlackboxEvent) => void;
}

export interface FixturePlayer {
  start(): void;
  stop(): void;
}

const REPLAY_INTERVAL_MS = 250;

export function createFixturePlayer(o: FixturePlayerOptions): FixturePlayer {
  let timer: ReturnType<typeof setInterval> | null = null;
  let i = 0;
  let started = false;

  return {
    start() {
      if (started) return;
      started = true;

      if (o.speed === 0) {
        for (const e of o.events) o.onEvent(e);
        return;
      }

      timer = setInterval(() => {
        if (i >= o.events.length) {
          if (timer !== null) clearInterval(timer);
          timer = null;
          return;
        }
        o.onEvent(o.events[i]);
        i += 1;
      }, REPLAY_INTERVAL_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

function ev(
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
  offsetSeconds = 0,
): unknown {
  return {
    seq,
    incidentId: "2608130442",
    t: new Date(Date.UTC(2026, 7, 13, 16, 0, offsetSeconds)).toISOString(),
    kind,
    payload,
  };
}

/**
 * Last-resort minimum so the dashboard is never a blank shell on a projector. Used only
 * when the fixture file is missing or yields zero valid events. Never the primary source.
 */
export const FALLBACK_EVENTS: readonly BlackboxEvent[] = (
  [
    ev(1, "status", {
      status: "on_scene",
      ref: "260813-0442",
      label: "Cardiac arrest",
      dispatchArea: "B3",
      unit: "14B",
      startedAt: new Date(Date.UTC(2026, 7, 13, 16, 0, 0)).toISOString(),
    }),
    ev(2, "node", { node: "triage", phase: "enter" }, 1),
    ev(3, "node", { node: "triage", phase: "exit" }, 2),
    ev(4, "node", { node: "signature_match", phase: "enter" }, 3),
    ev(
      5,
      "voice",
      {
        speaker: "agent",
        text: "Dispatched as sick. Heads up, this call type in B3 reclassifies to cardiac 18% of the time overnight.",
        clock: "42:19",
      },
      19,
    ),
    ev(
      6,
      "voice",
      {
        speaker: "medic",
        text: "Patient unresponsive, no radial pulse, starting compressions.",
        clock: "43:02",
      },
      62,
    ),
    ev(
      7,
      "voice",
      {
        speaker: "medic",
        text: "Skipping the supraglottic, family says recent neck surgery.",
        clock: "44:10",
      },
      130,
    ),
    ev(
      8,
      "decision",
      {
        decisionId: "dec-airway-0442",
        actionChosen: "Airway deferred",
        rationaleRecorded: true,
        protocolConflict: false,
      },
      131,
    ),
    ev(9, "node", { node: "readback_gate", phase: "enter" }, 135),
    ev(
      10,
      "voice",
      {
        speaker: "agent",
        text: "Confirming epinephrine, 1 milligram, IV push. Say confirm.",
        clock: "44:31",
      },
      151,
    ),
    ev(
      11,
      "readback",
      {
        state: "awaiting",
        readbackText: "Confirming epinephrine, 1 milligram, IV push. Say confirm.",
      },
      152,
    ),
    ev(12, "checkpoint", { count: 34 }, 156),
  ]
    .map(parseEvent)
    .filter((e): e is BlackboxEvent => e !== null)
);

/** Statically bundled. Never fetched, so it works offline in a production build. */
export function loadFixtureEvents(): BlackboxEvent[] {
  const source: unknown = raw;
  const rows = Array.isArray(source) ? source : [];
  const parsed = rows
    .map(parseEvent)
    .filter((e): e is BlackboxEvent => e !== null);
  return parsed.length > 0 ? parsed : [...FALLBACK_EVENTS];
}
