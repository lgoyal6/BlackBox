import type { ReactElement } from "react";
import { CallPanel } from "./call-panel";
import { GraphFooter } from "./graph-footer";
import { HeaderBar } from "./header-bar";
import type { EmbeddingInfo } from "./incident-types";
import { VectorSearchCard } from "./vector-search-card";
import { VoiceTimeline } from "./voice-timeline";
import type { DashboardView } from "./view-state";
import { WriteCounters } from "./write-counters";

export interface LiveViewProps {
  view: DashboardView;
  nowMs: number;
  live: boolean;
  embedding: EmbeddingInfo | null;
}

/** The live call: header, transcript, the phone, what Atlas retrieved, and the graph state. */
export function LiveView({ view, nowMs, live, embedding }: LiveViewProps): ReactElement {
  const recording = view.header.status !== null && view.header.status !== "closed";

  return (
    <>
      <HeaderBar header={view.header} recording={recording} />
      <div className="h-px shrink-0 bg-bb-border" />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 py-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex min-h-0 flex-col">
          <VoiceTimeline items={view.timeline} readback={view.readback} />
        </div>

        <div className="bb-scroll flex min-h-0 flex-col gap-3 overflow-y-auto">
          <CallPanel
            status={view.header.status}
            startedAtMs={view.header.startedAtMs}
            lastVoice={view.lastVoice}
            readback={view.readback}
            nowMs={nowMs}
            live={live}
          />
          <VectorSearchCard retrieval={view.retrieval} embedding={embedding} />
          <WriteCounters writes={view.writes} />
        </div>
      </div>

      <div className="h-px shrink-0 bg-bb-border" />
      <GraphFooter activeNode={view.activeNode} checkpointCount={view.checkpointCount} />
    </>
  );
}
