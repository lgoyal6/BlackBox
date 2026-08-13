import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import type { MongoClient } from "mongodb";
import { CHECKPOINTS, CHECKPOINT_WRITES } from "@/lib/contracts";
import { env } from "@/lib/env";

export function createCheckpointer(client: MongoClient): MongoDBSaver {
  // @langchain/langgraph-checkpoint-mongodb 1.4.0 depends on mongodb ^6.21.0, while this project
  // pins mongodb 7.5.0 (overview.md, PHASE-01-owned). npm nests a second mongodb copy for it, so
  // the two MongoClient classes are structurally the same client but nominally distinct types.
  const compatClient = client as unknown as ConstructorParameters<typeof MongoDBSaver>[0]["client"];
  return new MongoDBSaver({
    client: compatClient,
    dbName: env.mongodbDb,
    checkpointCollectionName: CHECKPOINTS,
    checkpointWritesCollectionName: CHECKPOINT_WRITES,
  });
}

const g = globalThis as unknown as { __bbCheckpointer?: Promise<MongoDBSaver> };

export async function ensureCheckpointer(client: MongoClient): Promise<MongoDBSaver> {
  if (!g.__bbCheckpointer) {
    g.__bbCheckpointer = (async () => {
      const saver = createCheckpointer(client);
      const errors = await saver.setup();
      if (errors.length > 0) {
        throw new Error(
          `MongoDBSaver.setup() reported ${errors.length} error(s): ${errors.map((e) => e.message).join("; ")}`,
        );
      }
      return saver;
    })();
  }
  return g.__bbCheckpointer;
}
