import { env } from "@/lib/env";
import { getDb } from "@/lib/db/client";
import { embeddings, retrieval } from "@/lib/registry";
import { VECTOR_COLLECTIONS, vectorIndexName } from "@/lib/contracts";
import { buildFanOutPipeline } from "@/lib/retrieval/pipeline";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf("=");
  return eq === -1 ? "true" : match.slice(eq + 1);
};

const showPipeline = flag("show-pipeline") !== undefined;
const adHocQuery = flag("query");
const limitOverride = flag("limit");

type Probe = { query: string; expectedSource: string };

const PROBES: Probe[] = [
  { query: "dispatched unconscious, found in cardiac arrest", expectedSource: "postmortems" },
  { query: "adult cardiac arrest compressions airway", expectedSource: "runbooks" },
  { query: "receiving facility on diversion, lost time rerouting", expectedSource: "postmortems (curated)" },
  { query: "weakness and nausea in an older patient, no chest pain", expectedSource: "demo call 2" },
];

async function checkIndexes(): Promise<void> {
  const db = getDb();
  console.log("=== Vector search index status ===");
  let anyNotReady = false;
  for (const coll of VECTOR_COLLECTIONS) {
    const indexName = vectorIndexName(coll);
    let rows: any[] = [];
    try {
      rows = await (db.collection(coll) as any).listSearchIndexes(indexName).toArray();
    } catch (err) {
      console.error(`FAIL: could not list search indexes on ${coll}: ${(err as Error).message}`);
      anyNotReady = true;
      continue;
    }
    if (rows.length === 0) {
      console.error(`FAIL: ${coll}: index ${indexName} does not exist`);
      anyNotReady = true;
      continue;
    }
    for (const row of rows) {
      const dims = row.latestDefinition?.fields?.find((f: any) => f.type === "vector")?.numDimensions;
      const status = row.status ?? row.queryable ? "READY" : "NOT READY";
      console.log(`  ${coll}.${row.name}: status=${row.status ?? "?"} numDimensions=${dims ?? "?"}`);
      if (row.status !== "READY") anyNotReady = true;
      if (dims !== undefined && dims !== env.embeddingDim) {
        console.error(
          `FAIL: ${coll}.${row.name}: numDimensions=${dims} does not match env.embeddingDim=${env.embeddingDim}`,
        );
        anyNotReady = true;
      }
    }
  }
  if (anyNotReady) {
    console.error("\nStop: one or more vs_* indexes are not READY or missing. Fix that before reading query output below.");
    process.exit(1);
  }
  console.log("All vs_* indexes READY.\n");
}

function printPipeline(): void {
  const pipeline = buildFanOutPipeline(new Array(env.embeddingDim).fill(0.01), {
    sources: ["decisions", "postmortems", "runbooks"],
    kPerSource: 8,
    limit: Number(limitOverride ?? 12),
    filters: {},
  });
  console.log(JSON.stringify(pipeline, null, 2));
}

async function runProbe(query: string, expected: string, isFake: boolean): Promise<void> {
  const port = await retrieval();
  const hits = await port.fanOut(query, { limit: Number(limitOverride ?? 12) });
  console.log(`\n--- probe: "${query}" (expected dominant source: ${expected}) ---`);
  console.table(
    hits.slice(0, 8).map((h) => ({
      source: h.source,
      rank: h.rank,
      score: h.score.toFixed(3),
      rrf: h.rrf.toFixed(5),
      title: h.title,
      snippet: h.text.slice(0, 60),
    })),
  );

  const distinctSources = new Set(hits.map((h) => h.source));
  const ranksOk = (() => {
    const bySource = new Map<string, number[]>();
    for (const h of hits) bySource.set(h.source, [...(bySource.get(h.source) ?? []), h.rank]);
    return [...bySource.values()].every((ranks) => {
      const sorted = [...ranks].sort((a, b) => a - b);
      return sorted[0] === 1 && sorted.every((r, i) => r === i + 1);
    });
  })();
  const spokenOk = hits.every((h) => h.spoken.trim().split(/\s+/).length <= 40);

  console.log(`distinct sources: ${distinctSources.size}, contiguous ranks: ${ranksOk}, spoken capped: ${spokenOk}`);

  if (isFake) {
    console.log("EMBEDDINGS_MODE=fake — relevance is not meaningful with hash vectors; structural checks only.");
    if (distinctSources.size < 2) throw new Error(`probe "${query}": expected hits from >= 2 distinct sources`);
    if (!ranksOk) throw new Error(`probe "${query}": ranks not contiguous from 1 per source`);
    if (!spokenOk) throw new Error(`probe "${query}": a spoken field exceeded 40 words`);
    return;
  }
  if (distinctSources.size < 2) {
    throw new Error(`probe "${query}": expected hits from >= 2 distinct sources, got ${[...distinctSources].join(",")}`);
  }
}

async function main(): Promise<void> {
  const isFake = (process.env.EMBEDDINGS_MODE ?? "real").toLowerCase() === "fake";

  await checkIndexes();

  if (showPipeline) {
    printPipeline();
    return;
  }

  if (adHocQuery) {
    await runProbe(adHocQuery, "ad-hoc", isFake);
    return;
  }

  if (isFake) {
    console.log("EMBEDDINGS_MODE=fake — skipping source-expectation assertions, structural checks only.\n");
  }

  for (const probe of PROBES) {
    await runProbe(probe.query, probe.expectedSource, isFake);
  }

  console.log("\nverify-retrieval: PASS");
}

main().catch((err) => {
  console.error("verify-retrieval: FAIL —", err instanceof Error ? err.message : err);
  process.exit(1);
});
