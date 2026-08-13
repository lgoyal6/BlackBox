export const VOYAGE_MAX_TEXTS = 128;
export const VOYAGE_MAX_APPROX_TOKENS = 120_000;
export const OPENAI_MAX_TEXTS = 256;

/** Rough token estimate. Deliberately crude — 4 characters per token. */
export function approxTokens(text: string): number {
  return text.length / 4;
}

export interface BatchLimits {
  maxTexts: number;
  maxApproxTokens?: number;
}

/** Splits indices (not texts) into batches, preserving input order within and across batches. */
export function planBatches(texts: string[], limits: BatchLimits): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let tokens = 0;

  for (let i = 0; i < texts.length; i++) {
    const nextTokens = approxTokens(texts[i] ?? "");
    const full = current.length >= limits.maxTexts;
    const overTokens =
      limits.maxApproxTokens !== undefined &&
      current.length > 0 &&
      tokens + nextTokens > limits.maxApproxTokens;

    if (full || overTokens) {
      batches.push(current);
      current = [];
      tokens = 0;
    }

    current.push(i);
    tokens += nextTokens;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
