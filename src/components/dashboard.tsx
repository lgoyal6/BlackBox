"use client";

import { useEffect, useState, type ReactElement } from "react";
import { IncidentsTab } from "./incidents-tab";
import type { IncidentBundle } from "./incident-types";
import { LiveView } from "./live-view";
import { RecorderGlyph } from "./ui";
import { useEventStream } from "./use-event-stream";

export type TabId = "live" | "corpus";

export interface DashboardProps {
  incidentId: string | null;
  mode: "real" | "fixture";
  replay: boolean;
  bundle: IncidentBundle;
  initialTab: TabId;
}

const TABS: readonly { id: TabId; label: string }[] = [
  { id: "live", label: "Live call" },
  { id: "corpus", label: "What it remembers" },
];

// The boundary is transitive, so only this file needs "use client". It also owns the one
// interval in the tree: the elapsed clock costs a single re-render per second for
// everything, rather than one timer per component.
export function Dashboard({
  incidentId,
  mode,
  replay,
  bundle,
  initialTab,
}: DashboardProps): ReactElement {
  const { view } = useEventStream({ incidentId, mode, replay });
  const [tab, setTab] = useState<TabId>(initialTab);
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (mode !== "real" || tab !== "live") return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mode, tab]);

  // Fixture mode is a static snapshot, so its clock is anchored to the newest event rather
  // than to wall time. That keeps the reference state identical across reloads.
  const nowMs = mode === "real" ? tick : (view.lastEventTMs ?? tick);

  return (
    <main className="flex h-dvh flex-col px-7">
      <nav className="flex shrink-0 items-center justify-between gap-4 pt-4">
        <div className="flex items-center gap-2">
          <RecorderGlyph className="text-bb-red" />
          <span className="text-base font-semibold tracking-[0.18em] text-bb-text">
            BLACKBOX
          </span>
        </div>

        <div className="flex items-center gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={t.id === tab ? "page" : undefined}
              className={`rounded-full px-4 py-[6px] text-sm font-medium transition-colors ${
                t.id === tab
                  ? "bg-bb-surface-2 text-bb-text"
                  : "text-bb-muted hover:text-bb-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {tab === "live" ? (
        <LiveView view={view} nowMs={nowMs} live={mode === "real"} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col py-4">
          <IncidentsTab bundle={bundle} />
        </div>
      )}
    </main>
  );
}
