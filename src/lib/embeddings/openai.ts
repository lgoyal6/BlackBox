import OpenAI from "openai";
import { env } from "@/lib/env";

let client: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (!client) {
    client = new OpenAI({
      apiKey: env.openaiApiKey,
      timeout: 30_000,
      maxRetries: 0,
    });
  }
  return client;
}

export async function embedOpenAI(
  texts: string[],
  _inputType: "document" | "query",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await getOpenAI().embeddings.create({
    model: env.embeddingModel,
    input: texts,
  });
  return [...response.data]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}
