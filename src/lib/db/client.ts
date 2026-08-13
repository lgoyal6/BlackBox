import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import { env } from "@/lib/env";

const g = globalThis as unknown as { __bbClient?: MongoClient };

export function getClient(): MongoClient {
  if (!env.mongodbUri) {
    throw new Error("MONGODB_URI is not set");
  }
  if (!g.__bbClient) {
    g.__bbClient = new MongoClient(env.mongodbUri, {
      appName: "blackbox",
    });
  }
  return g.__bbClient;
}

export function getDb(): Db {
  return getClient().db(env.mongodbDb);
}

export function col<T extends Document>(name: string): Collection<T> {
  return getDb().collection<T>(name);
}

export async function ping(): Promise<{ ok: number; version: string; replicaSet: string | null }> {
  const client = getClient();
  await client.connect();
  const admin = client.db("admin");
  const [hello, buildInfo] = await Promise.all([
    admin.command({ hello: 1 }),
    admin.command({ buildInfo: 1 }),
  ]);
  const replicaSet =
    typeof hello.setName === "string" && hello.setName.length > 0 ? hello.setName : null;
  const version = typeof buildInfo.version === "string" ? buildInfo.version : "unknown";
  return { ok: 1, version, replicaSet };
}
