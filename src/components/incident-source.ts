import { parseIncidentBundle } from "./parse-corpus";
import type { IncidentBundle } from "./incident-types";
// Statically bundled snapshot of the Atlas corpus, exactly like fixtures/event-stream.json.
// No fetch, no driver in the bundle, works with the network unplugged.
import raw from "./incident-fixture.json";

/**
 * Front end only, by design. The snapshot is the pitch insurance policy.
 * Live Atlas data comes from `loadLiveCorpus` / `GET /api/corpus`.
 */
export function loadIncidentBundle(): IncidentBundle {
  const parsed = parseIncidentBundle(raw as unknown);
  return { ...parsed, source: "snapshot" };
}
