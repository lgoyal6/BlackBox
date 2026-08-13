import type { GraphNode, Hit } from "@/lib/contracts";
import { GRAPH_STAGES } from "@/lib/contracts";

// The four-pill grouping is a contract (contracts §4), not a component invention.
export { GRAPH_STAGES };

export type StageId = (typeof GRAPH_STAGES)[number]["id"];

export const DOT = " · ";

/**
 * Returns null when the anchor is unknown so the caller can render "-- : --".
 * A timer reading 00:00 during a live call looks like the dashboard is dead.
 */
export function formatElapsed(
  startedAtMs: number | null,
  nowMs: number,
): { mm: string; ss: string } | null {
  if (startedAtMs === null || !Number.isFinite(startedAtMs)) return null;
  const total = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  return {
    mm: String(Math.floor(total / 60)).padStart(2, "0"),
    ss: String(total % 60).padStart(2, "0"),
  };
}

/** Exactly two decimals, e.g. 0.9 -> "0.90". */
export function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "--";
}

/** "Incident 4471" | "Protocol: cardiac arrest" */
export function hitTitle(hit: Hit): string {
  if (hit.source === "runbooks") return `Protocol: ${hit.title}`;
  return `Incident ${hit.displayId ?? hit.title}`;
}

/** "Prior run:" for decisions and postmortems, "Protocol:" for runbooks. */
export function snippetLabel(hit: Hit): string {
  return hit.source === "runbooks" ? "Protocol:" : "Prior run:";
}

/** "Cardiac arrest" from "cardiac arrest". First letter only; the rest is left alone. */
export function sentenceCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function activeStageId(node: GraphNode | null): StageId | null {
  if (node === null) return null;
  for (const stage of GRAPH_STAGES) {
    if ((stage.nodes as readonly string[]).includes(node)) return stage.id;
  }
  return null;
}
