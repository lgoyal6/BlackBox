import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import type { EmbeddingsPort } from "@/lib/ports";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vectorFor(text: string): number[] {
  const digest = createHash("sha256").update(text).digest();
  const seed = digest.readUInt32LE(0) ^ digest.readUInt32LE(4) ^ digest.readUInt32LE(8);
  const rand = mulberry32(seed);
  const dim = env.embeddingDim;
  const values = new Array<number>(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i += 1) {
    const v = rand() * 2 - 1;
    values[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq) || 1;
  return values.map((v) => v / norm);
}

async function embed(texts: string[], _inputType: "document" | "query"): Promise<number[][]> {
  return texts.map(vectorFor);
}

async function embedOne(text: string, _inputType?: "document" | "query"): Promise<number[]> {
  return vectorFor(text);
}

function info(): { provider: string; model: string; dim: number } {
  return { provider: "fake-hash", model: env.embeddingModel, dim: env.embeddingDim };
}

const embeddings: EmbeddingsPort = { embed, embedOne, info };
export default embeddings;
