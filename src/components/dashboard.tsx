"use client";

import { useEffect, useState, type ReactElement } from "react";
import { CallPanel } from "./call-panel";
import { GraphFooter } from "./graph-footer";
import { HeaderBar } from "./header-bar";
import { useEventStream } from "./use-event-stream";
import { VoiceTimeline } from "./voice-timeline";

export interface DashboardProps {
  incidentId: string | null;
  mode: "real" | "fixture";
  replay: boolean;
}

// The boundary is transitive, so only this file needs "use client". It also owns the one
// interval in the tree: the elapsed clock costs a single re-render per second for
// everything, rather than one timer per component.
export function Dashboard({ incidentId, mode, replay }: DashboardProps): ReactElement {
  const { view } = useEventStream({ incidentId, mode, replay });
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (mode !== "real") return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mode]);

  // Fixture mode is a static snapshot, so its clock is anchored to the newest event rather
  // than to wall time. That keeps the reference state byte-identical across reloads.
  const nowMs = mode === "real" ? tick : (view.lastEventTMs ?? tick);
  const recording = view.header.status !== null && view.header.status !== "closed";

  return (
    <main className="flex h-dvh flex-col px-7">
      <HeaderBar header={view.header} recording={recording} />
      <div className="h-px shrink-0 bg-bb-border" />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 py-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex min-h-0 flex-col">
          <VoiceTimeline items={view.timeline} readback={view.readback} />
        </div>
        <div className="flex min-h-0 justify-center">
          <CallPanel
            status={view.header.status}
            startedAtMs={view.header.startedAtMs}
            lastVoice={view.lastVoice}
            readback={view.readback}
            nowMs={nowMs}
            live={mode === "real"}
          />
        </div>
      </div>

      <div className="h-px shrink-0 bg-bb-border" />
      <GraphFooter activeNode={view.activeNode} checkpointCount={view.checkpointCount} />
    </main>
  );
}
