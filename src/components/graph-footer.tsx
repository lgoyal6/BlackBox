import { useEffect, useRef, useState, type ReactElement } from "react";
import type { GraphNode } from "@/lib/contracts";
import { GRAPH_NODE_ORDER } from "@/lib/contracts";
import { activeStageId, GRAPH_STAGES } from "./format";
import { CheckpointGlyph, ChevronGlyph } from "./ui";

// Every GraphNode must map to a stage, or an arriving node lights nothing. A mismatch is
// reported and then ignored: a screen with no amber pill is recoverable on stage, a screen
// blanked by a thrown error in a client component is not.
const MAPPED_NODES = new Set(GRAPH_STAGES.flatMap((s) => [...s.nodes]));
const UNMAPPED = GRAPH_NODE_ORDER.filter((n) => !MAPPED_NODES.has(n));
const STAGE_COVERAGE_OK = UNMAPPED.length === 0;

if (!STAGE_COVERAGE_OK && process.env.NODE_ENV !== "production") {
  console.error(`GRAPH_STAGES does not cover: ${UNMAPPED.join(", ")}`);
}

const FLASH_MS = 400;

/**
 * The single most important pixel on this screen: the presenter reads it aloud, kills the
 * process, and reads it again. The ring flash is red because a checkpoint increment is
 * BlackBox capturing something.
 */
export function CheckpointCounter({ count }: { count: number }): ReactElement {
  const previous = useRef(count);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (previous.current === count) return;
    previous.current = count;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [count]);

  return (
    <div
      className={`flex items-center gap-2 rounded-full px-3 py-1 ${flashing ? "bb-checkpoint-flash" : ""}`}
    >
      <CheckpointGlyph className="text-bb-text" />
      <span className="text-[15px] font-medium text-bb-text">checkpoint</span>
      <span className="bb-tabular text-[17px] font-bold text-bb-text">{count}</span>
    </div>
  );
}

export interface GraphFooterProps {
  activeNode: GraphNode | null;
  checkpointCount: number;
}

export function GraphFooter({ activeNode, checkpointCount }: GraphFooterProps): ReactElement {
  const active = STAGE_COVERAGE_OK ? activeStageId(activeNode) : null;

  return (
    <footer className="flex items-center justify-between gap-4 py-[14px]">
      <div className="flex items-center gap-2">
        <span className="text-sm text-bb-muted">Graph</span>
        {GRAPH_STAGES.map((stage, i) => (
          <div key={stage.id} className="flex items-center gap-2">
            {i > 0 ? <ChevronGlyph className="text-bb-muted opacity-60" /> : null}
            <span
              className={`rounded-full px-3 py-[5px] text-sm font-medium ${
                stage.id === active
                  ? "border border-bb-amber-border bg-bb-amber-surface text-bb-amber"
                  : "border border-bb-border-strong text-bb-muted"
              }`}
            >
              {stage.label}
            </span>
          </div>
        ))}
      </div>

      <CheckpointCounter count={checkpointCount} />
    </footer>
  );
}
