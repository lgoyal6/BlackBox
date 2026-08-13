import type { Document } from "mongodb";
import { VECTOR_PATH, vectorIndexName, type CallTypeFamily, type RetrievalSource } from "@/lib/contracts";

export interface ResolvedFanOutOptions {
  sources: RetrievalSource[];
  kPerSource: number;
  limit: number;
  filters: Partial<Record<RetrievalSource, Document>>;
}

type FieldMap = {
  title: string;
  text: string;
  displayId: string | null;
  meta: Document;
};

const NORMALIZE: Record<RetrievalSource, FieldMap> = {
  decisions: {
    title: "$actionChosen",
    text: "$embeddedText",
    displayId: "$displayId",
    meta: {
      incidentId: "$incidentId",
      rationale: "$rationale",
      outcome: "$outcome",
      protocolConflict: "$protocolConflict",
      callTypeFamily: "$callTypeFamily",
    },
  },
  postmortems: {
    title: "$whatChanged",
    text: "$narrative",
    displayId: "$displayId",
    meta: {
      incidentId: "$incidentId",
      origin: "$origin",
      severityDelta: "$severityDelta",
      lessons: "$lessons",
      callTypeFamily: "$callTypeFamily",
    },
  },
  runbooks: {
    title: "$sectionTitle",
    text: "$text",
    displayId: null,
    meta: {
      pageStart: "$pageStart",
      pageEnd: "$pageEnd",
      sectionPath: "$sectionPath",
    },
  },
  remediations: {
    title: "$action",
    text: "$embeddedText",
    displayId: null,
    meta: {
      incidentId: "$incidentId",
      outcome: "$outcome",
      costMinutes: "$costMinutes",
      durationSeconds: "$durationSeconds",
      sideEffects: "$sideEffects",
      callTypeFamily: "$callTypeFamily",
    },
  },
};

export function buildSourcePipeline(
  source: RetrievalSource,
  queryVector: number[],
  k: number,
  filter?: Document,
): Document[] {
  const map = NORMALIZE[source];
  return [
    {
      $vectorSearch: {
        index: vectorIndexName(source),
        path: VECTOR_PATH,
        queryVector,
        numCandidates: k * 20,
        limit: k,
        ...(filter ? { filter } : {}),
      },
    },
    { $addFields: { source, score: { $meta: "vectorSearchScore" } } },
    {
      $project: {
        _id: 0,
        docId: { $toString: "$_id" },
        source: "$source",
        score: "$score",
        title: map.title,
        text: map.text,
        displayId: map.displayId,
        meta: map.meta,
      },
    },
  ];
}

export function buildFanOutPipeline(
  queryVector: number[],
  opts: ResolvedFanOutOptions,
): Document[] {
  const [base, ...rest] = opts.sources;
  return [
    ...buildSourcePipeline(base, queryVector, opts.kPerSource, opts.filters[base]),
    ...rest.map((coll) => ({
      $unionWith: {
        coll,
        pipeline: buildSourcePipeline(coll, queryVector, opts.kPerSource, opts.filters[coll]),
      },
    })),
    { $sort: { source: 1, score: -1 } },
  ];
}

/** Vector `filter` for callTypeFamily. Never pass this for `runbooks` — RunbookDoc has no such field. */
export function callTypeFamilyFilter(family?: CallTypeFamily): Document | undefined {
  return family ? { callTypeFamily: { $eq: family } } : undefined;
}

/** Best-effort classifiers for the two Atlas failure modes pipeline.ts's callers must degrade against. */
export function isMissingVectorIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /index.*not.*found|no such index|unknown search index|\$vectorSearch is not allowed|ns not found/i.test(msg);
}

export function isUndeclaredFilterPathError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /filter.*(not|un).*(index|declared|allow)|path.*not.*(index|filter)/i.test(msg);
}
