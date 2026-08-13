import { EMPTY_BUNDLE, type EmbeddingInfo, type IncidentBundle } from "./incident-types";

function asEmbedding(value: unknown): EmbeddingInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.provider !== "string" || typeof o.model !== "string" || typeof o.dim !== "number") {
    return null;
  }
  return { provider: o.provider, model: o.model, dim: o.dim };
}

/**
 * Revive a corpus payload from JSON (the snapshot file or GET /api/corpus).
 * Drops a malformed payload rather than rendering a half-shaped tree.
 */
export function parseIncidentBundle(raw: unknown): IncidentBundle {
  if (typeof raw !== "object" || raw === null) return EMPTY_BUNDLE;

  const b = raw as Partial<IncidentBundle>;
  if (!Array.isArray(b.incidents)) {
    return { ...EMPTY_BUNDLE, error: "Corpus payload is empty or malformed." };
  }

  return {
    incidents: b.incidents,
    reports: b.reports ?? {},
    remediations: b.remediations ?? {},
    stats: b.stats ?? EMPTY_BUNDLE.stats,
    error: typeof b.error === "string" ? b.error : null,
    source: b.source === "live" ? "live" : "snapshot",
    liveIncidentId: typeof b.liveIncidentId === "string" ? b.liveIncidentId : null,
    embedding: asEmbedding(b.embedding),
  };
}
