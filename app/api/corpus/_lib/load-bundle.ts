import {
  INCIDENTS,
  POSTMORTEMS,
  REMEDIATIONS,
  RUNBOOKS,
  callTypeFamily,
  labelFor,
  type CallTypeFamily,
  type IncidentDoc,
  type MemoryOrigin,
  type PostmortemDoc,
  type RemediationDoc,
  type RemediationOutcome,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { embeddings } from "@/lib/registry";
import {
  EMPTY_BUNDLE,
  type CorpusStats,
  type EmbeddingInfo,
  type IncidentBundle,
  type IncidentRemediation,
  type IncidentReport,
  type IncidentSummary,
} from "@/components/incident-types";

const FAMILIES = new Set<CallTypeFamily>([
  "cardiac",
  "respiratory",
  "altered",
  "trauma",
  "behavioral",
  "general",
  "other",
]);
const ORIGINS = new Set<MemoryOrigin>(["seeded", "curated", "live"]);

function asFamily(value: unknown, fallbackCode: string): CallTypeFamily {
  if (typeof value === "string" && FAMILIES.has(value as CallTypeFamily)) {
    return value as CallTypeFamily;
  }
  return callTypeFamily(fallbackCode);
}

function asOrigin(value: unknown): MemoryOrigin {
  if (typeof value === "string" && ORIGINS.has(value as MemoryOrigin)) {
    return value as MemoryOrigin;
  }
  return "seeded";
}

function asOutcome(value: unknown): RemediationOutcome {
  return value === "success" ? "success" : "failure";
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toSummary(doc: IncidentDoc, hasReport: boolean): IncidentSummary {
  const initialCallType = asString(doc.cad?.initialCallType);
  const gt = doc._groundTruth;
  const finalCallType = asString(gt?.finalCallType) || null;
  const severityDelta = asNumber(gt?.severityDelta);

  return {
    incidentId: asString(doc.incidentId),
    displayId: asString(doc.displayId),
    ref: asString(doc.ref),
    initialCallType,
    initialLabel: labelFor(initialCallType),
    finalCallType,
    finalLabel: finalCallType !== null ? labelFor(finalCallType) : null,
    borough: asString(doc.cad?.borough),
    dispatchArea: asString(doc.cad?.dispatchArea),
    unit: asString(doc.cad?.unit) || null,
    family: asFamily(doc.callTypeFamily, initialCallType),
    responseSeconds: asNumber(gt?.incidentResponseSeconds),
    severityDelta,
    reopened: gt?.reopenIndicator === true,
    reclassified: finalCallType !== null && finalCallType !== initialCallType,
    hasReport,
  };
}

function toReport(doc: PostmortemDoc): IncidentReport {
  return {
    incidentId: asString(doc.incidentId),
    displayId: asString(doc.displayId),
    narrative: asString(doc.narrative),
    whatChanged: asString(doc.whatChanged),
    lessons: Array.isArray(doc.lessons)
      ? doc.lessons.filter((l): l is string => typeof l === "string")
      : [],
    origin: asOrigin(doc.origin),
  };
}

function toRemediation(doc: RemediationDoc): IncidentRemediation {
  return {
    action: asString(doc.action),
    outcome: asOutcome(doc.outcome),
    costMinutes: asNumber(doc.costMinutes),
    sideEffects: Array.isArray(doc.sideEffects)
      ? doc.sideEffects.filter((s): s is string => typeof s === "string")
      : [],
    origin: asOrigin(doc.origin),
  };
}

async function embeddingInfo(): Promise<EmbeddingInfo | null> {
  try {
    return (await embeddings()).info();
  } catch {
    return null;
  }
}

/**
 * Judge-facing corpus for the dashboard. Reads `_groundTruth` on purpose: this is not a
 * retrieval path or a graph node. Embeddings stay on the server.
 */
export async function loadLiveCorpus(): Promise<IncidentBundle> {
  try {
    const [incidentDocs, postmortemDocs, remediationDocs, sectionTitles, liveDoc, embedding] =
      await Promise.all([
        col<IncidentDoc>(INCIDENTS)
          .find(
            { isLive: false },
            {
              projection: {
                _id: 0,
                incidentId: 1,
                displayId: 1,
                ref: 1,
                cad: 1,
                callTypeFamily: 1,
                _groundTruth: 1,
              },
            },
          )
          .toArray(),
        col<PostmortemDoc>(POSTMORTEMS)
          .find(
            {},
            {
              projection: {
                _id: 0,
                embedding: 0,
                embeddedText: 0,
              },
            },
          )
          .toArray(),
        col<RemediationDoc>(REMEDIATIONS)
          .find(
            {},
            {
              projection: {
                _id: 0,
                embedding: 0,
                embeddedText: 0,
              },
            },
          )
          .toArray(),
        col(RUNBOOKS).distinct("sectionTitle"),
        col<IncidentDoc>(INCIDENTS).findOne(
          { isLive: true },
          { sort: { updatedAt: -1 }, projection: { _id: 0, incidentId: 1 } },
        ),
        embeddingInfo(),
      ]);

    const reports: Record<string, IncidentReport> = {};
    for (const doc of postmortemDocs) {
      const report = toReport(doc);
      if (!report.incidentId) continue;
      reports[report.incidentId] = report;
    }

    const remediations: Record<string, IncidentRemediation[]> = {};
    let failures = 0;
    for (const doc of remediationDocs) {
      const item = toRemediation(doc);
      const id = asString(doc.incidentId);
      if (!id) continue;
      if (item.outcome === "failure") failures += 1;
      const list = remediations[id] ?? [];
      list.push(item);
      remediations[id] = list;
    }

    const incidents = incidentDocs.map((doc) =>
      toSummary(doc, Object.hasOwn(reports, asString(doc.incidentId))),
    );

    const stats: CorpusStats = {
      incidents: incidents.length,
      reclassified: incidents.filter((i) => i.reclassified).length,
      undertriaged: incidents.filter((i) => i.severityDelta !== null && i.severityDelta > 0)
        .length,
      reports: Object.keys(reports).length,
      failures,
      runbookSections: sectionTitles.filter((s) => typeof s === "string" && s.length > 0).length,
    };

    return {
      incidents,
      reports,
      remediations,
      stats,
      error: incidents.length === 0 ? "Atlas corpus is empty." : null,
      source: "live",
      liveIncidentId: asString(liveDoc?.incidentId) || null,
      embedding,
    };
  } catch (err) {
    console.error(
      `[corpus] live load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ...EMPTY_BUNDLE,
      source: "live",
      error: "Could not read the Atlas corpus.",
    };
  }
}
