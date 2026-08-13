import { EMPTY_BUNDLE, type IncidentBundle } from "./incident-types";
// Statically bundled snapshot of the Atlas corpus, exactly like fixtures/event-stream.json.
// No fetch, no driver in the bundle, works with the network unplugged.
import raw from "./incident-fixture.json";

/**
 * Front end only, by design.
 *
 * This is a real snapshot taken from the Atlas cluster, not invented data, so the tab looks
 * and reads correctly today without any backend wiring. When an incidents endpoint exists,
 * swapping this one function for a fetch is the entire change — nothing else in the tree
 * knows where the bundle came from.
 */
export function loadIncidentBundle(): IncidentBundle {
  const source = raw as unknown;
  if (typeof source !== "object" || source === null) return EMPTY_BUNDLE;

  const b = source as Partial<IncidentBundle>;
  if (!Array.isArray(b.incidents) || b.incidents.length === 0) {
    return { ...EMPTY_BUNDLE, error: "Corpus snapshot is empty or malformed." };
  }

  return {
    incidents: b.incidents,
    reports: b.reports ?? {},
    remediations: b.remediations ?? {},
    stats: b.stats ?? EMPTY_BUNDLE.stats,
    error: null,
  };
}
