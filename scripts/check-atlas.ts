import { VECTOR_COLLECTIONS } from "@/lib/contracts";
import { col, ping } from "@/lib/db/client";
import { assertEmbeddingConfig, env } from "@/lib/env";
import { embeddings, events, graph, llm, memory, retrieval, voice } from "@/lib/registry";

const SCRATCH = "_phase01_check";
const NEEDED_VECTOR_INDEXES = 4;
const M0_SEARCH_INDEX_CAP = 3;

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
let failed = false;

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}: ${detail}`);
  if (!ok) failed = true;
}

function warn(detail: string): void {
  console.warn(`[WARN] ${detail}`);
}

async function countSearchIndexes(): Promise<{ total: number; vector: number }> {
  let total = 0;
  let vector = 0;
  for (const name of VECTOR_COLLECTIONS) {
    const indexes = await col(name).listSearchIndexes().toArray();
    total += indexes.length;
    for (const index of indexes) {
      const blob = JSON.stringify(index);
      const type = "type" in index ? String(index.type) : "";
      if (type.toLowerCase().includes("vector") || blob.includes("vectorSearch") || blob.includes("knnBeta")) {
        vector += 1;
      }
    }
  }
  return { total, vector };
}

async function roundTrip(): Promise<void> {
  const scratch = col<{ ping: boolean; t: Date }>(SCRATCH);
  const now = new Date();
  const inserted = await scratch.insertOne({ ping: true, t: now });
  const found = await scratch.findOne({ _id: inserted.insertedId });
  await scratch.deleteOne({ _id: inserted.insertedId });
  if (!found) throw new Error("scratch write was not readable back");
}

async function portReport(): Promise<void> {
  const ports = [
    ["embeddings", embeddings, "EMBEDDINGS_MODE"],
    ["retrieval", retrieval, "RETRIEVAL_MODE"],
    ["memory", memory, "MEMORY_MODE"],
    ["llm", llm, "LLM_MODE"],
    ["events", events, "EVENTS_MODE"],
    ["graph", graph, "GRAPH_MODE"],
    ["voice", voice, "VOICE_MODE"],
  ] as const;

  console.log("\nPort resolution under current env:");
  for (const [name, loader, key] of ports) {
    const setting = process.env[key] ?? "real";
    const impl = await loader();
    const label =
      name === "embeddings" && "info" in impl
        ? `provider=${impl.info().provider}`
        : impl.constructor?.name || "object";
    console.log(`  ${name.padEnd(12)} ${key}=${setting} → ${label}`);
  }
}

async function main(): Promise<void> {
  console.log("BlackBox Atlas preflight\n");

  try {
    assertEmbeddingConfig();
    record(
      "env",
      true,
      `model=${env.embeddingModel} dim=${env.embeddingDim} db=${env.mongodbDb}`,
    );
  } catch (error) {
    record("env", false, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!env.mongodbUri) {
    record("uri", false, "MONGODB_URI is empty. Copy .env.example to .env.local and fill it in.");
    process.exit(1);
  }

  try {
    const hello = await ping();
    record("ping", hello.ok === 1, `server version ${hello.version}`);
    record(
      "change-streams",
      hello.replicaSet !== null,
      hello.replicaSet
        ? `replica set ${hello.replicaSet}`
        : "hello.setName missing — this is not a replica set; change streams will not work",
    );
  } catch (error) {
    record("ping", false, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  try {
    await col(VECTOR_COLLECTIONS[0]).listSearchIndexes().toArray();
    record("atlas-search", true, "listSearchIndexes() is callable");
  } catch (error) {
    record(
      "atlas-search",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const { total, vector } = await countSearchIndexes();
    const remainingIfM0 = Math.max(0, M0_SEARCH_INDEX_CAP - total);
    const canFitFour = total + remainingIfM0 >= NEEDED_VECTOR_INDEXES && remainingIfM0 >= NEEDED_VECTOR_INDEXES - vector;
    record(
      "vector-index-budget",
      true,
      `${vector} vector / ${total} search indexes on ${VECTOR_COLLECTIONS.join(", ")}`,
    );
    if (total < NEEDED_VECTOR_INDEXES) {
      warn(
        `This project needs ${NEEDED_VECTOR_INDEXES} vector search indexes. Atlas M0 caps at ${M0_SEARCH_INDEX_CAP}. ` +
        `Existing search indexes: ${total}. If this cluster is M0, provision Flex before PHASE-02.`,
      );
    }
    if (!canFitFour && total < NEEDED_VECTOR_INDEXES) {
      warn("Fewer than 4 vector indexes can exist on an M0 cluster. Confirm the tier is Flex or higher.");
    }
  } catch (error) {
    record(
      "vector-index-budget",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    await roundTrip();
    record("write-access", true, `insert/find/delete on ${SCRATCH} succeeded`);
  } catch (error) {
    record("write-access", false, error instanceof Error ? error.message : String(error));
  }

  await portReport();

  console.log(
    "\nCluster tier: Atlas Admin API (MCP) is not reachable from this environment. " +
    "Confirm Flex or higher in the Atlas UI; M0 cannot hold 4 vector indexes.",
  );

  if (failed) {
    console.error("\nPreflight failed.");
    process.exit(1);
  }
  console.log("\nPreflight passed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
