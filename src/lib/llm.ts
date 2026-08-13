import OpenAI from "openai";
import { env } from "@/lib/env";
import type { LlmPort } from "@/lib/ports";

let client: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (!client) {
    client = new OpenAI({
      apiKey: env.openaiApiKey,
      timeout: 20_000,
      maxRetries: 2,
    });
  }
  return client;
}

async function json<T>(prompt: string, schema: unknown, opts?: { model?: string }): Promise<T> {
  const completion = await getOpenAI().chat.completions.create({
    model: opts?.model ?? env.llmModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Return a JSON object that matches the provided schema. Do not invent clinical facts, doses, or rationales.",
      },
      {
        role: "user",
        content: `${prompt}\n\nSchema:\n${JSON.stringify(schema)}`,
      },
    ],
  });
  const raw = completion.choices[0]?.message.content;
  if (!raw) throw new Error("LLM json() returned an empty completion");
  return JSON.parse(raw) as T;
}

async function text(prompt: string, opts?: { model?: string; maxWords?: number }): Promise<string> {
  const cap = opts?.maxWords ? ` Keep the answer under ${opts.maxWords} words.` : "";
  const completion = await getOpenAI().chat.completions.create({
    model: opts?.model ?? env.llmModel,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You write short operational prose. Never propose treatment, diagnosis, or a dose of your own." + cap,
      },
      { role: "user", content: prompt },
    ],
  });
  const raw = completion.choices[0]?.message.content?.trim();
  if (!raw) throw new Error("LLM text() returned an empty completion");
  return raw;
}

const llm: LlmPort = { json, text };
export default llm;
