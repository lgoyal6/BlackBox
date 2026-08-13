import {
  CHECKPOINTS,
  CHECKPOINT_WRITES,
} from "@/lib/contracts";
import { getClient } from "@/lib/db/client";
import {
  dropVectorIndexes,
  ensureCollections,
  ensureStandardIndexes,
  ensureVectorIndexes,
  waitForVectorIndexes,
  type VectorIndexStatus,
} from "@/lib/db/indexes";
import { applyValidators } from "@/lib/db/validators";
import { assertEmbeddingConfig, env } from "@/lib/env";

const args = new Set(process.argv.slice(2));
const skipWait = args.has("--skip-wait");
const dropVector = args.has("--drop-vector");

function printStatuses(elapsedMs: number, statuses: VectorIndexStatus[]): void {
  const elapsed = Math.floor(elapsedMs / 1000);
  const parts = statuses.map((status) => `${status.name} ${status.status}`).join("  ");
  console.log(`  ${elapsed}s  ${parts}`);
}

async function closeClient(): Promise<void> {
  try {
    if (env.mongodbUri) await getClient().close();
  } catch {
    // Script is exiting; a close failure should not mask the real result.
  }
}

async function main(): Promise<void> {
  assertEmbeddingConfig();
  console.log(
    `numDimensions = ${env.embeddingDim}   (EMBEDDING_MODEL=${env.embeddingModel}, EMBEDDING_DIM=${env.embeddingDim})`,
  );

  if (!env.mongodbUri) {
    throw new Error("MONGODB_URI is not set. Copy .env.example to .env.local and fill it in.");
  }

  const collections = await ensureCollections();
  for (const report of collections) {
    console.log(`  collection ${report.name}: ${report.created ? "created" : "already present"}`);
  }
  console.log(
    `${CHECKPOINTS} / ${CHECKPOINT_WRITES} are managed by LangGraph MongoDBSaver — not created here`,
  );

  const validators = await applyValidators();
  for (const report of validators) {
    console.log(`  validator ${report.collection}: ${report.action}`);
  }

  const standard = await ensureStandardIndexes();
  for (const report of standard) {
    console.log(`  index ${report.collection}.${report.name}: ${report.created ? "created" : "unchanged"}`);
  }

  if (dropVector) {
    console.log("Dropping all four vs_* indexes (--drop-vector)");
    await dropVectorIndexes();
  }

  const vector = await ensureVectorIndexes();
  for (const report of vector) {
    console.log(`  ${report.spec.name}: ${report.action}`);
  }

  if (skipWait) {
    console.warn(
      "WARNING: --skip-wait set. Vector queries may return empty arrays until all vs_* indexes " +
        "report READY and queryable=true. This is indistinguishable from a broken query.",
    );
  } else {
    const ready = await waitForVectorIndexes({ onPoll: printStatuses });
    console.log("Vector indexes:");
    for (const status of ready) {
      console.log(
        `  ${status.name.padEnd(18)} ${status.status.padEnd(10)} queryable=${status.queryable}  dims=${status.numDimensions}`,
      );
    }
  }

  console.log(
    `indexes: ${collections.length} collections, ${standard.length} standard, ` +
      `${vector.length} vector ${skipWait ? "submitted" : "READY"} (numDimensions=${env.embeddingDim})`,
  );
}

main()
  .then(async () => {
    await closeClient();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    await closeClient();
    process.exit(1);
  });
