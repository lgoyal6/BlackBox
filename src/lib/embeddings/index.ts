import { assertEmbeddingConfig, env } from "@/lib/env";
import type { EmbeddingsPort } from "@/lib/ports";
import {
  OPENAI_MAX_TEXTS,
  VOYAGE_MAX_APPROX_TOKENS,
  VOYAGE_MAX_TEXTS,
  planBatches,
  type BatchLimits,
} from "./batch";
import { cacheKey, getCached, putCached, type EmbedCacheDoc } from "./cache";
import { embedOpenAI } from "./openai";
import { withRetry } from "./retry";
import { embedVoyage } from "./voyage";

assertEmbeddingConfig();

export type ProviderFn = (
  texts: string[],
  inputType: "document" | "query",
) => Promise<number[][]>;

function defaultLimits(): BatchLimits {
  if (env.embeddingProvider.toLowerCase() === "openai") {
    return { maxTexts: OPENAI_MAX_TEXTS };
  }
  return { maxTexts: VOYAGE_MAX_TEXTS, maxApproxTokens: VOYAGE_MAX_APPROX_TOKENS };
}

function resolveProvider(): ProviderFn {
  return env.embeddingProvider.toLowerCase() === "openai" ? embedOpenAI : embedVoyage;
}

function positionsFor(map: Map<string, number[]>, text: string): number[] {
  const positions = map.get(text);
  if (!positions) {
    throw new Error("embedding internal error: missing text positions");
  }
  return positions;
}

function assertComplete(out: Array<number[] | undefined>, expected: number): asserts out is number[][] {
  const filled = out.filter((v) => v !== undefined).length;
  if (out.length !== expected || filled !== expected) {
    throw new Error(`embedding output incomplete: expected ${expected} vectors, got ${filled}`);
  }
}

/** The seam. All logic lives here; the provider is injected so this is testable with no key. */
export async function embedWithProvider(
  provider: ProviderFn,
  texts: string[],
  inputType: "document" | "query",
  opts?: { limits?: BatchLimits; useCache?: boolean },
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const textToIndices = new Map<string, number[]>();
  const unique: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? "";
    const existing = textToIndices.get(text);
    if (existing) {
      existing.push(i);
    } else {
      textToIndices.set(text, [i]);
      unique.push(text);
    }
  }

  const useCache = opts?.useCache !== false;
  const hashes = unique.map((text) => cacheKey(env.embeddingModel, inputType, text));
  const cached = useCache ? await getCached(hashes) : new Map<string, number[]>();

  const out: Array<number[] | undefined> = new Array(texts.length);
  const misses: string[] = [];
  for (let u = 0; u < unique.length; u++) {
    const text = unique[u] ?? "";
    const hit = cached.get(hashes[u] ?? "");
    if (hit) {
      for (const idx of positionsFor(textToIndices, text)) out[idx] = hit;
    } else {
      misses.push(text);
    }
  }

  const limits = opts?.limits ?? defaultLimits();
  const batches = planBatches(misses, limits);
  const fresh: EmbedCacheDoc[] = [];

  for (const batch of batches) {
    const batchTexts = batch.map((i) => misses[i] ?? "");
    const vectors = await withRetry(
      () => provider(batchTexts, inputType),
      { label: `embed:${env.embeddingProvider}` },
    );
    if (vectors.length !== batchTexts.length) {
      throw new Error(
        `embedding count mismatch: provider returned ${vectors.length}, expected ${batchTexts.length}`,
      );
    }
    for (let j = 0; j < vectors.length; j++) {
      const vec = vectors[j];
      if (!vec || vec.length !== env.embeddingDim) {
        throw new Error(
          `embedding dim mismatch: provider returned ${vec?.length ?? 0}, EMBEDDING_DIM is ${env.embeddingDim}`,
        );
      }
      const text = batchTexts[j] ?? "";
      for (const idx of positionsFor(textToIndices, text)) out[idx] = vec;
      fresh.push({
        hash: cacheKey(env.embeddingModel, inputType, text),
        model: env.embeddingModel,
        inputType,
        dim: env.embeddingDim,
        vector: vec,
        t: new Date(),
      });
    }
  }

  if (useCache && fresh.length > 0) {
    await putCached(fresh);
  }

  assertComplete(out, texts.length);
  return out;
}

export async function embed(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  return embedWithProvider(resolveProvider(), texts, inputType);
}

export async function embedOne(
  text: string,
  inputType: "document" | "query" = "query",
): Promise<number[]> {
  const [vector] = await embed([text], inputType);
  if (!vector) {
    throw new Error("embedOne returned no vector");
  }
  return vector;
}

export function info(): { provider: string; model: string; dim: number } {
  return {
    provider: env.embeddingProvider,
    model: env.embeddingModel,
    dim: env.embeddingDim,
  };
}

const impl: EmbeddingsPort = { embed, embedOne, info };
export default impl;
