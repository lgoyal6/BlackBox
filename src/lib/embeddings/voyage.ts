import { env } from "@/lib/env";
import { type HttpishError, withRetry } from "./retry";

export const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

interface VoyageItem {
  embedding: number[];
  index: number;
}

function httpError(message: string, status?: number): HttpishError {
  const err = new Error(message) as HttpishError;
  err.status = status;
  return err;
}

function voyageMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: string;
      message?: string;
      error?: { message?: string };
    };
    return (
      parsed.detail ??
      parsed.error?.message ??
      parsed.message ??
      (body.trim() || `Voyage embeddings failed with status ${status}`)
    );
  } catch {
    return body.trim() || `Voyage embeddings failed with status ${status}`;
  }
}

async function embedVoyageOnce(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  if (!env.voyageApiKey) {
    throw new Error("VOYAGE_API_KEY is not set");
  }

  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.voyageApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: env.embeddingModel,
      input_type: inputType,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await res.text();
  if (!res.ok) {
    throw httpError(voyageMessage(body, res.status), res.status);
  }

  const parsed = JSON.parse(body) as { data?: VoyageItem[] };
  const data = parsed.data;
  if (!Array.isArray(data)) {
    throw new Error("Voyage embeddings response missing data[]");
  }

  return [...data]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

export async function embedVoyage(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  return withRetry(() => embedVoyageOnce(texts, inputType), { label: "voyage" });
}
