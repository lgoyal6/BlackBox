import type { ReactElement } from "react";
import { loadLiveCorpus } from "./api/corpus/_lib/load-bundle";
import { Dashboard, type TabId } from "@/components/dashboard";
import { loadIncidentBundle } from "@/components/incident-source";

export const dynamic = "force-dynamic";

/**
 * Next.js 16 makes searchParams a Promise. Reading it synchronously is the first thing
 * that breaks, and the error points at React internals rather than at this line.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    incidentId?: string;
    mode?: string;
    replay?: string;
    tab?: string;
  }>;
}): Promise<ReactElement> {
  const params = await searchParams;

  // NEXT_PUBLIC_* is inlined at build time, so flipping it in a production build needs a
  // rebuild — which nobody is doing on stage. The query override makes recovering from a
  // dead backend mid-pitch eight characters and an Enter.
  const mode: "real" | "fixture" =
    params.mode === "fixture"
      ? "fixture"
      : params.mode === "real"
        ? "real"
        : process.env.NEXT_PUBLIC_EVENTS_MODE === "fixture"
          ? "fixture"
          : "real";

  const initialTab: TabId = params.tab === "corpus" ? "corpus" : "live";
  const snapshot = loadIncidentBundle();
  const live = mode === "real" ? await loadLiveCorpus() : snapshot;
  const bundle = live.error === null && live.incidents.length > 0 ? live : snapshot;

  return (
    <Dashboard
      incidentId={params.incidentId ?? bundle.liveIncidentId}
      mode={mode}
      replay={params.replay === "1"}
      bundle={bundle}
      initialTab={initialTab}
    />
  );
}
