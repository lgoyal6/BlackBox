import { createHash } from "node:crypto";
import { EMBED_CACHE } from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { env } from "@/lib/env";

export interface EmbedCacheDoc {
  hash: string;
  model: string;
  inputType: "document" | "query";
  dim: number;
  vector: number[];
  t: Date;
}

export function cacheKey(model: string, inputType: string, text: string): string {
  return createHash("sha256").update(`${model}:${inputType}:${text}`).digest("hex");
}

/** One find({ hash: { $in } }). Returns only entries whose dim matches env.embeddingDim. */
export async function getCached(hashes: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (hashes.length === 0) return out;
  try {
    const docs = await col<EmbedCacheDoc>(EMBED_CACHE)
      .find({ hash: { $in: hashes } })
      .project<Pick<EmbedCacheDoc, "hash" | "vector" | "dim">>({ hash: 1, vector: 1, dim: 1 })
      .toArray();
    for (const doc of docs) {
      if (doc.dim !== env.embeddingDim) continue;
      out.set(doc.hash, doc.vector);
    }
  } catch (err) {
    console.warn("[embed-cache] getCached failed; treating as miss", err);
  }
  return out;
}

export async function putCached(rows: EmbedCacheDoc[]): Promise<number> {
  if (rows.length === 0) return 0;
  const byHash = new Map<string, EmbedCacheDoc>();
  for (const row of rows) byHash.set(row.hash, row);
  const unique = [...byHash.values()];
  try {
    const result = await col<EmbedCacheDoc>(EMBED_CACHE).bulkWrite(
      unique.map((row) => ({
        updateOne: {
          filter: { hash: row.hash },
          update: { $set: row },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return result.upsertedCount + result.modifiedCount;
  } catch (err) {
    console.warn("[embed-cache] putCached failed; continuing without cache", err);
    return 0;
  }
}
