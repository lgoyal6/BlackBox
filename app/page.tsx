import type { ReactElement } from "react";
import { Dashboard } from "@/components/dashboard";

/**
 * Next.js 16 makes searchParams a Promise. Reading it synchronously is the first thing
 * that breaks, and the error points at React internals rather than at this line.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ incidentId?: string; mode?: string; replay?: string }>;
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

  return (
    <Dashboard
      incidentId={params.incidentId ?? null}
      mode={mode}
      replay={params.replay === "1"}
    />
  );
}
