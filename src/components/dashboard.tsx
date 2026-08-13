"use client";

import { useEffect, useState, type ReactElement } from "react";
import { IncidentsTab } from "./incidents-tab";
import type { IncidentBundle } from "./incident-types";
import { LiveView } from "./live-view";
import { parseIncidentBundle } from "./parse-corpus";
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

const CORPUS_POLL_MS = 12_000;

/**
 * "Atlas live · voyage" is the single strongest credibility claim on the screen — every number
 * here arrived over a change stream, embedded by a MongoDB-owned model. Rendered as 14px muted
 * text it read as a debug string; a judge scanning the frame has to be able to find it. The
 * dot carries the state so the text stays short enough to read from the back of the room.
 */
function StatusPill({
  mode,
  connection,
  provider,
}: {
  mode: "real" | "fixture";
  connection: string;
  provider: string | null;
}): ReactElement {
  const fixture = mode === "fixture";
  const open = !fixture && connection === "open";

  const label = fixture
    ? "fixture"
    : open
      ? provider !== null
        ? `Atlas live · ${provider}`
        : "Atlas live"
      : connection;

  const dot = fixture ? "bg-bb-muted" : open ? "bg-bb-live" : "bg-bb-amber";
  const text = fixture ? "text-bb-muted" : open ? "text-bb-text" : "text-bb-muted-bright";

  return (
    <span
      className={`inline-flex items-center gap-[6px] rounded-full border border-bb-border-strong bg-bb-surface px-[10px] py-[3px] font-mono text-sm ${text}`}
    >
      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

// The boundary is transitive, so only this file needs "use client". It also owns the one
// interval in the tree: the elapsed clock costs a single re-render per second for
// everything, rather than one timer per component.
export function Dashboard({
  incidentId: incidentIdProp,
  mode,
  replay,
  bundle: initialBundle,
  initialTab,
}: DashboardProps): ReactElement {
  const [bundle, setBundle] = useState(initialBundle);
  const [incidentId, setIncidentId] = useState(incidentIdProp);
  const { view, connection, embedding } = useEventStream({ incidentId, mode, replay });
  const [tab, setTab] = useState<TabId>(initialTab);
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (mode !== "real" || tab !== "live") return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mode, tab]);

  useEffect(() => {
    if (mode !== "real") return;

    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const res = await fetch("/api/corpus", { cache: "no-store" });
        if (!res.ok) return;
        const next = parseIncidentBundle(await res.json());
        if (cancelled || next.incidents.length === 0) return;
        setBundle(next);
        if (incidentIdProp === null && next.liveIncidentId !== null) {
          setIncidentId(next.liveIncidentId);
        }
      } catch {
        // Keep the last good bundle — a missed poll must not blank the tab.
      }
    };

    void refresh();
    const id = setInterval(() => void refresh(), CORPUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [mode, incidentIdProp]);

  // Fixture mode is a static snapshot, so its clock is anchored to the newest event rather
  // than to wall time. That keeps the reference state identical across reloads.
  const nowMs = mode === "real" ? tick : (view.lastEventTMs ?? tick);
  const provider = embedding?.provider ?? bundle.embedding?.provider ?? null;

  return (
    <main className="flex h-dvh flex-col px-7">
      <nav className="flex shrink-0 items-center justify-between gap-4 pt-4">
        <div className="flex items-center gap-2">
          <RecorderGlyph className="text-bb-red" />
          <span className="text-base font-semibold tracking-[0.18em] text-bb-text">
            BLACKBOX
          </span>
          <StatusPill mode={mode} connection={connection} provider={provider} />
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
        <LiveView
          view={view}
          nowMs={nowMs}
          live={mode === "real"}
          embedding={embedding ?? bundle.embedding}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col py-4">
          <IncidentsTab bundle={bundle} />
        </div>
      )}
    </main>
  );
}
