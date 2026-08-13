import { col } from "@/lib/db/client";
import { embeddings } from "@/lib/registry";
import {
  DECISIONS,
  POSTMORTEMS,
  SIGNATURE_MATCH_FLOOR,
  labelFor,
  type IncidentDoc,
  type RetrievalSource,
  type SignatureMatch,
} from "@/lib/contracts";
import { buildFanOutPipeline } from "./pipeline";
import { fuse, type RawRow } from "./fuse";
import { toSpoken } from "./spoken";

const SIGNATURE_SOURCES: RetrievalSource[] = [DECISIONS, POSTMORTEMS];
const MEDIC_TEXT_CAP = 300;

export function buildSignatureQuery(incident: IncidentDoc): string {
  const medicText = incident.timeline
    .filter((entry) => entry.source === "medic")
    .map((entry) => entry.text)
    .join(" ")
    .slice(0, MEDIC_TEXT_CAP);

  return [
    labelFor(incident.cad.initialCallType),
    `severity level ${incident.cad.initialSeverityLevelCode}`,
    incident.cad.dispatchArea,
    incident.cad.borough,
    medicText,
  ]
    .filter(Boolean)
    .join(". ");
}

function buildSummary(displayId: string, topHit: RawRow): string {
  const lessons = Array.isArray(topHit.meta.lessons) ? (topHit.meta.lessons as unknown[]) : [];
  const firstLesson =
    typeof lessons[0] === "string" && lessons[0].trim() ? (lessons[0] as string) : topHit.text;
  return toSpoken(`Similar to incident ${displayId}: ${topHit.title}. ${firstLesson}`, 25);
}

export async function signatureMatch(incident: IncidentDoc): Promise<SignatureMatch | null> {
  const query = buildSignatureQuery(incident);
  const queryVector = await (await embeddings()).embedOne(query, "query");
  const pipeline = buildFanOutPipeline(queryVector, {
    sources: SIGNATURE_SOURCES,
    kPerSource: 8,
    limit: 12,
    filters: {},
  });

  let rows: RawRow[];
  try {
    rows = await col<RawRow>(SIGNATURE_SOURCES[0]).aggregate<RawRow>(pipeline).toArray();
  } catch {
    return null;
  }

  const hits = fuse(rows, 12);
  const topRow = rows.find((r) => r.docId === hits[0]?.docId);
  const topHit = hits[0];

  // Compared against the RAW score, never the fused rrf — rrf sits near 0.02, always below the 0.62 floor.
  if (!topHit || !topRow || topHit.score < SIGNATURE_MATCH_FLOOR) return null;

  const displayId = topHit.displayId ?? incident.displayId;
  return {
    hits,
    summary: buildSummary(displayId, topRow),
    displayId,
    confidence: topHit.score,
  };
}
