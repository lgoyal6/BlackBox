import type { BlackboxEvent, GraphNode, Hit, IncidentStatus } from "@/lib/contracts";

/**
 * Reducer-complete, component-minimal.
 *
 * Every one of the nine BlackboxEvent kinds is reduced here, including `retrieval`,
 * `write` and `pcr`, which the current (reduced-scope) dashboard does not render.
 * Promoting a deferred card later is then purely additive UI — no reducer edit and no
 * re-test of the event plumbing. See docs/superpowers/specs/2026-08-13-blackbox-dashboard-design.md.
 */

/** Names the prior incident a recalled agent turn came from. */
export interface RecallTag {
  displayId: string;
  score: number;
  source: Hit["source"];
}

export interface VoiceTurn {
  seq: number;
  speaker: "medic" | "agent";
  text: string;
  clock: string;
  /** Set when this agent turn immediately followed a retrieval. The memory proof. */
  recall: RecallTag | null;
}

export interface DecisionCapture {
  seq: number;
  decisionId: string;
  actionChosen: string;
  rationaleRecorded: boolean;
  protocolConflict: boolean;
}

/** Turns and decisions interleave in one ordered list; `seq` is the ordering key. */
export type TimelineItem =
  | { type: "turn"; seq: number; turn: VoiceTurn }
  | { type: "decision"; seq: number; decision: DecisionCapture };

export interface ReadbackView {
  state: "awaiting" | "confirmed" | "rejected";
  readbackText: string;
  /** seq of the newest timeline item when this readback arrived; the pill renders after it. */
  afterSeq: number;
}

export interface HeaderView {
  ref: string | null;
  label: string | null;
  dispatchArea: string | null;
  unit: string | null;
  status: IncidentStatus | null;
  /** Anchor for the elapsed timer. Always status.payload.startedAt, never event.t. */
  startedAtMs: number | null;
}

export interface RetrievalView {
  query: string;
  hits: Hit[];
  /** docId of the hit that would render as the expanded snippet: highest rrf, ties by array order. */
  primaryDocId: string | null;
}

/** Who spoke last and when, so the call panel can degrade to "listening" after a silence. */
export interface LastVoice {
  speaker: "medic" | "agent";
  atMs: number;
}

export interface DashboardView {
  header: HeaderView;
  timeline: TimelineItem[];
  readback: ReadbackView | null;
  retrieval: RetrievalView | null;
  lastVoice: LastVoice | null;
  /** Newest event timestamp seen. Anchors the elapsed clock in fixture mode. */
  lastEventTMs: number | null;
  /** Held between a retrieval and the next agent turn, then cleared. */
  pendingRecall: RecallTag | null;
  writes: Record<string, number>;
  checkpointCount: number;
  activeNode: GraphNode | null;
  pcrPreview: string | null;
  /** Highest seq applied, keyed by `incidentId ?? "__global"`. Drives replay dedupe. */
  appliedSeq: Record<string, number>;
  gapCount: number;
  unknownKindCount: number;
}

export const EMPTY_VIEW: DashboardView = {
  header: {
    ref: null,
    label: null,
    dispatchArea: null,
    unit: null,
    status: null,
    startedAtMs: null,
  },
  timeline: [],
  readback: null,
  retrieval: null,
  lastVoice: null,
  lastEventTMs: null,
  pendingRecall: null,
  writes: {},
  checkpointCount: 0,
  activeNode: null,
  pcrPreview: null,
  appliedSeq: {},
  gapCount: 0,
  unknownKindCount: 0,
};

const VOICE_SPEAKERS = new Set(["medic", "agent"]);
const READBACK_STATES = new Set(["awaiting", "confirmed", "rejected"]);
const NODE_PHASES = new Set(["enter", "exit"]);

const KINDS = new Set([
  "status",
  "node",
  "voice",
  "decision",
  "readback",
  "retrieval",
  "write",
  "checkpoint",
  "pcr",
]);

function bucketOf(e: BlackboxEvent): string {
  return e.incidentId ?? "__global";
}

function newestSeq(timeline: readonly TimelineItem[]): number {
  return timeline.length === 0 ? -1 : timeline[timeline.length - 1].seq;
}

/** Highest rrf wins, ties broken by array order. Scores are not comparable across sources. */
function primaryByRrf(hits: readonly Hit[]): string | null {
  let best: Hit | null = null;
  for (const h of hits) {
    if (best === null || h.rrf > best.rrf) best = h;
  }
  return best?.docId ?? null;
}

/**
 * The recall tag names one prior incident and displays that incident's own score, so it
 * ranks by `score` rather than `rrf`. Runbook hits carry a null displayId and never
 * name an incident. If the vector-search card is ever promoted, reconcile this with its
 * rrf ranking — see the design doc.
 */
function recallFrom(hits: readonly Hit[]): RecallTag | null {
  let best: Hit | null = null;
  for (const h of hits) {
    if (h.displayId === null) continue;
    if (best === null || h.score > best.score) best = h;
  }
  if (best === null) return null;
  return { displayId: best.displayId as string, score: best.score, source: best.source };
}

/** Idempotent. Applying the same event twice is a no-op; returns the same object when skipped. */
export function reduceEvent(view: DashboardView, e: BlackboxEvent): DashboardView {
  const key = bucketOf(e);
  const mark = view.appliedSeq[key];
  if (mark !== undefined && e.seq <= mark) return view;

  const gapped = mark !== undefined && e.seq > mark + 1;
  const tMs = e.t.getTime();
  const next: DashboardView = {
    ...view,
    appliedSeq: { ...view.appliedSeq, [key]: e.seq },
    gapCount: gapped ? view.gapCount + 1 : view.gapCount,
    lastEventTMs: view.lastEventTMs === null ? tMs : Math.max(view.lastEventTMs, tMs),
  };

  switch (e.kind) {
    case "status": {
      const p = e.payload;
      next.header = {
        ref: p.ref,
        label: p.label,
        dispatchArea: p.dispatchArea,
        unit: p.unit ?? null,
        status: p.status,
        startedAtMs: p.startedAt instanceof Date ? p.startedAt.getTime() : null,
      };
      return next;
    }

    case "node": {
      const p = e.payload;
      if (p.phase === "enter") {
        next.activeNode = p.node;
      } else if (view.activeNode === p.node) {
        // Only the currently active node may clear itself. Without this guard an
        // out-of-order exit clears a node that has already advanced and the footer goes dark.
        next.activeNode = null;
      }
      return next;
    }

    case "voice": {
      const p = e.payload;
      const recall = p.speaker === "agent" ? view.pendingRecall : null;
      const turn: VoiceTurn = {
        seq: e.seq,
        speaker: p.speaker,
        text: p.text,
        clock: p.clock,
        recall,
      };
      next.timeline = [...view.timeline, { type: "turn", seq: e.seq, turn }];
      next.lastVoice = { speaker: p.speaker, atMs: e.t.getTime() };
      if (recall !== null) next.pendingRecall = null;
      return next;
    }

    case "decision": {
      const p = e.payload;
      const decision: DecisionCapture = {
        seq: e.seq,
        decisionId: p.decisionId,
        actionChosen: p.actionChosen,
        rationaleRecorded: p.rationaleRecorded,
        protocolConflict: p.protocolConflict,
      };
      next.timeline = [...view.timeline, { type: "decision", seq: e.seq, decision }];
      return next;
    }

    case "readback": {
      const p = e.payload;
      next.readback = {
        state: p.state,
        readbackText: p.readbackText,
        afterSeq: newestSeq(view.timeline),
      };
      return next;
    }

    case "retrieval": {
      const p = e.payload;
      const hits = Array.isArray(p.hits) ? p.hits : [];
      next.retrieval = { query: p.query, hits, primaryDocId: primaryByRrf(hits) };
      next.pendingRecall = recallFrom(hits) ?? view.pendingRecall;
      return next;
    }

    case "write": {
      // `count` is the absolute total for the bucket, not a delta. A delta would
      // double-count every event in the 200-event replay frame on every reload.
      const p = e.payload;
      next.writes = { ...view.writes, [p.collection]: p.count };
      return next;
    }

    case "checkpoint": {
      // Never decreases — the presenter has already read the old number aloud.
      next.checkpointCount = Math.max(view.checkpointCount, e.payload.count);
      return next;
    }

    case "pcr": {
      next.pcrPreview = e.payload.preview;
      return next;
    }

    default: {
      // Compile-time exhaustiveness: adding a kind to the contract breaks the build here
      // rather than silently dropping a frame. At runtime this must never throw — a thrown
      // error in a client component blanks the whole screen.
      const exhaustive: never = e;
      void exhaustive;
      next.unknownKindCount = view.unknownKindCount + 1;
      return next;
    }
  }
}

export function reduceAll(events: readonly BlackboxEvent[]): DashboardView {
  let view = EMPTY_VIEW;
  for (const e of events) view = reduceEvent(view, e);
  return view;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function payloadOk(kind: string, p: Record<string, unknown>): boolean {
  switch (kind) {
    case "status":
      return (
        typeof p.status === "string" &&
        typeof p.ref === "string" &&
        typeof p.label === "string" &&
        typeof p.dispatchArea === "string"
      );
    case "node":
      return typeof p.node === "string" && NODE_PHASES.has(p.phase as string);
    case "voice":
      return (
        VOICE_SPEAKERS.has(p.speaker as string) &&
        typeof p.text === "string" &&
        typeof p.clock === "string"
      );
    case "decision":
      return typeof p.decisionId === "string" && typeof p.actionChosen === "string";
    case "readback":
      return READBACK_STATES.has(p.state as string) && typeof p.readbackText === "string";
    case "retrieval":
      return typeof p.query === "string" && Array.isArray(p.hits);
    case "write":
      return typeof p.collection === "string" && typeof p.count === "number";
    case "checkpoint":
      return typeof p.count === "number";
    case "pcr":
      return typeof p.postmortemId === "string" && typeof p.preview === "string";
    default:
      return false;
  }
}

/**
 * Revives `t` (and status.startedAt) into Dates and shape-checks `kind`. Returns null on
 * malformed input. JSON gives `t` as an ISO string while BlackboxEvent.t is a Date, so the
 * revival step is mandatory, not cleanup.
 */
export function parseEvent(raw: unknown): BlackboxEvent | null {
  const o = asRecord(raw);
  if (o === null) return null;

  const kind = o.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (typeof o.seq !== "number" || !Number.isFinite(o.seq)) return null;

  const t = asDate(o.t);
  if (t === null) return null;

  const incidentId =
    typeof o.incidentId === "string" ? o.incidentId : o.incidentId === null ? null : undefined;
  if (incidentId === undefined) return null;

  const payload = asRecord(o.payload);
  if (payload === null || !payloadOk(kind, payload)) return null;

  if (kind === "status") {
    const startedAt = asDate(payload.startedAt);
    if (startedAt === null) return null;
    return { seq: o.seq, incidentId, t, kind, payload: { ...payload, startedAt } } as BlackboxEvent;
  }

  return { seq: o.seq, incidentId, t, kind, payload } as BlackboxEvent;
}
