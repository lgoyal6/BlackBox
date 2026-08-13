import type { Document } from "mongodb";
import { col } from "@/lib/db/client";
import { embeddings } from "@/lib/registry";
import {
  DECISIONS,
  FAN_OUT_COLLECTIONS,
  RUNBOOKS,
  vectorIndexName,
  type CallTypeFamily,
  type Hit,
  type RetrievalSource,
} from "@/lib/contracts";
import type { RetrievalPort } from "@/lib/ports";
import {
  buildFanOutPipeline,
  callTypeFamilyFilter,
  isMissingVectorIndexError,
  isUndeclaredFilterPathError,
} from "./pipeline";
import { fuse, type RawRow } from "./fuse";
import { signatureMatch } from "./signature";
import { failureMemory } from "./failures";
import { reclassPrior } from "./priors";

const K_PER_SOURCE = 8;
const LIMIT = 12;
const OVER_FETCH_MULTIPLIER = 3;

function buildFilters(
  sources: RetrievalSource[],
  family?: CallTypeFamily,
): Partial<Record<RetrievalSource, Document>> {
  const filters: Partial<Record<RetrievalSource, Document>> = {};
  if (!family) return filters;
  for (const source of sources) {
    // RunbookDoc has no callTypeFamily field, and vs_runbooks does not declare that filter path.
    if (source === RUNBOOKS) continue;
    const clause = callTypeFamilyFilter(family);
    if (clause) filters[source] = clause;
  }
  return filters;
}

async function runAggregate(
  sources: RetrievalSource[],
  queryVector: number[],
  kPerSource: number,
  limit: number,
  filters: Partial<Record<RetrievalSource, Document>>,
): Promise<RawRow[]> {
  if (sources.length === 0) return [];
  const pipeline = buildFanOutPipeline(queryVector, { sources, kPerSource, limit, filters });
  return col<RawRow>(sources[0]).aggregate<RawRow>(pipeline).toArray();
}

export async function fanOutFrom(
  query: string,
  sources: RetrievalSource[],
  opts?: { kPerSource?: number; limit?: number; callTypeFamily?: CallTypeFamily },
): Promise<Hit[]> {
  const kPerSource = opts?.kPerSource ?? K_PER_SOURCE;
  const limit = opts?.limit ?? LIMIT;
  const queryVector = await (await embeddings()).embedOne(query, "query");
  const filters = buildFilters(sources, opts?.callTypeFamily);

  let activeSources = sources;
  let rows: RawRow[];
  try {
    rows = await runAggregate(activeSources, queryVector, kPerSource, limit, filters);
  } catch (err) {
    if (activeSources[0] === DECISIONS && isMissingVectorIndexError(err)) {
      console.warn(
        `fanOut: ${vectorIndexName(DECISIONS)} unavailable (index still building or PHASE-02 ` +
          `not yet run) — dropping "decisions" from this fan-out`,
      );
      activeSources = activeSources.filter((s) => s !== DECISIONS);
      rows = await runAggregate(activeSources, queryVector, kPerSource, limit, filters);
    } else if (Object.keys(filters).length > 0 && isUndeclaredFilterPathError(err)) {
      console.warn(
        "fanOut: callTypeFamily filter path not declared on a vector index, retrying without it " +
          "and post-filtering in TypeScript (degraded recall)",
      );
      const unfiltered = await runAggregate(
        activeSources,
        queryVector,
        kPerSource * OVER_FETCH_MULTIPLIER,
        limit,
        {},
      );
      rows = unfiltered.filter(
        (row) => row.source === RUNBOOKS || row.meta.callTypeFamily === opts?.callTypeFamily,
      );
    } else {
      throw err;
    }
  }

  return fuse(rows, limit);
}

export async function fanOut(
  query: string,
  opts?: { kPerSource?: number; limit?: number; callTypeFamily?: CallTypeFamily },
): Promise<Hit[]> {
  return fanOutFrom(query, [...FAN_OUT_COLLECTIONS], opts);
}

const retrieval: RetrievalPort = { fanOut, signatureMatch, failureMemory, reclassPrior };
export default retrieval;
