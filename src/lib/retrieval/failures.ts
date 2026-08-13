import type { Document } from "mongodb";
import { col } from "@/lib/db/client";
import { embeddings } from "@/lib/registry";
import { POSTMORTEMS, REMEDIATIONS, type CallTypeFamily, type Hit, type RetrievalSource } from "@/lib/contracts";
import { buildFanOutPipeline, isUndeclaredFilterPathError } from "./pipeline";
import { fuse, type RawRow } from "./fuse";

const FAILURE_SOURCES: RetrievalSource[] = [REMEDIATIONS, POSTMORTEMS];
const K_PER_SOURCE = 8;
const LIMIT = 12;
const OVER_FETCH_MULTIPLIER = 3;

function baseFilters(family?: CallTypeFamily): Partial<Record<RetrievalSource, Document>> {
  const familyClause = family ? { callTypeFamily: { $eq: family } } : {};
  return {
    [REMEDIATIONS]: { outcome: { $eq: "failure" }, ...familyClause },
    [POSTMORTEMS]: { severityDelta: { $gt: 0 }, ...familyClause },
  };
}

function isKnownFailure(row: RawRow): boolean {
  if (row.source === REMEDIATIONS) return row.meta.outcome === "failure";
  const delta = row.meta.severityDelta;
  return typeof delta === "number" && delta > 0;
}

export async function failureMemory(query: string, family?: CallTypeFamily): Promise<Hit[]> {
  const queryVector = await (await embeddings()).embedOne(query, "query");

  try {
    const pipeline = buildFanOutPipeline(queryVector, {
      sources: FAILURE_SOURCES,
      kPerSource: K_PER_SOURCE,
      limit: LIMIT,
      filters: baseFilters(family),
    });
    const rows = await col<RawRow>(FAILURE_SOURCES[0]).aggregate<RawRow>(pipeline).toArray();
    return fuse(rows, LIMIT);
  } catch (err) {
    if (!isUndeclaredFilterPathError(err)) throw err;
    console.warn(
      "failureMemory: outcome/severityDelta filter path not declared on a vector index, " +
        "retrying without filters and post-filtering (degraded recall)",
    );
    const pipeline = buildFanOutPipeline(queryVector, {
      sources: FAILURE_SOURCES,
      kPerSource: K_PER_SOURCE * OVER_FETCH_MULTIPLIER,
      limit: LIMIT,
      filters: {},
    });
    const rows = await col<RawRow>(FAILURE_SOURCES[0]).aggregate<RawRow>(pipeline).toArray();
    return fuse(rows.filter(isKnownFailure), LIMIT);
  }
}
