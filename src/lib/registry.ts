import type {
  EmbeddingsPort,
  EventsPort,
  GraphPort,
  LlmPort,
  MemoryPort,
  RetrievalPort,
  VoicePort,
} from "@/lib/ports";

type Cache = {
  embeddings?: EmbeddingsPort;
  retrieval?: RetrievalPort;
  memory?: MemoryPort;
  llm?: LlmPort;
  events?: EventsPort;
  graph?: GraphPort;
  voice?: VoicePort;
};

const cache: Cache = {};

function mode(key: string): string {
  return (process.env[key] ?? "real").toLowerCase();
}

function warnFake(port: string, reason: string): void {
  console.warn(`FAKE PORT: ${port} — ${reason}. Demo will not hit the real implementation.`);
}

export async function embeddings(): Promise<EmbeddingsPort> {
  if (cache.embeddings) return cache.embeddings;
  if (mode("EMBEDDINGS_MODE") !== "fake") {
    try {
      const mod = await import("@/lib/embeddings");
      cache.embeddings = mod.default;
      return cache.embeddings;
    } catch {
      warnFake("embeddings", "real module missing, falling back to fake");
    }
  }
  const mod = await import("@/lib/fakes/embeddings");
  cache.embeddings = mod.default;
  return cache.embeddings;
}

export async function retrieval(): Promise<RetrievalPort> {
  if (cache.retrieval) return cache.retrieval;
  if (mode("RETRIEVAL_MODE") !== "fake") {
    try {
      const mod = await import("@/lib/retrieval");
      cache.retrieval = mod.default;
      return cache.retrieval;
    } catch {
      warnFake("retrieval", "real module missing, falling back to fake");
    }
  }
  const mod = await import("@/lib/fakes/retrieval");
  cache.retrieval = mod.default;
  return cache.retrieval;
}

export async function memory(): Promise<MemoryPort> {
  if (cache.memory) return cache.memory;
  if (mode("MEMORY_MODE") !== "fake") {
    try {
      const mod = await import("@/lib/memory");
      cache.memory = mod.default;
      return cache.memory;
    } catch {
      warnFake("memory", "real module missing, falling back to fake");
    }
  }
  const mod = await import("@/lib/fakes/memory");
  cache.memory = mod.default;
  return cache.memory;
}

export async function llm(): Promise<LlmPort> {
  if (cache.llm) return cache.llm;
  if (mode("LLM_MODE") !== "fake") {
    try {
      const mod = await import("@/lib/llm");
      cache.llm = mod.default;
      return cache.llm;
    } catch {
      warnFake("llm", "real module missing, falling back to fake");
    }
  }
  const mod = await import("@/lib/fakes/llm");
  cache.llm = mod.default;
  return cache.llm;
}

export async function events(): Promise<EventsPort> {
  if (cache.events) return cache.events;
  if (mode("EVENTS_MODE") !== "fake") {
    try {
      const mod = await import("@/lib/events");
      cache.events = mod.default;
      return cache.events;
    } catch {
      warnFake("events", "real module missing, falling back to fake");
    }
  }
  const mod = await import("@/lib/fakes/events");
  cache.events = mod.default;
  return cache.events;
}

export async function graph(): Promise<GraphPort> {
  if (cache.graph) return cache.graph;
  if (mode("GRAPH_MODE") !== "fake") {
    try {
      const mod = await import("@/lib/graph");
      cache.graph = mod.default;
      return cache.graph;
    } catch {
      warnFake("graph", "real module missing, falling back to fake");
    }
  }
  const mod = await import("@/lib/fakes/graph");
  cache.graph = mod.default;
  return cache.graph;
}

export async function voice(): Promise<VoicePort> {
  if (cache.voice) return cache.voice;
  if (mode("VOICE_MODE") !== "fake") {
    try {
      const mod = await import("@/lib/voice");
      cache.voice = mod.default;
      return cache.voice;
    } catch {
      warnFake("voice", "real module missing, falling back to fake");
    }
  }
  const mod = await import("@/lib/fakes/voice");
  cache.voice = mod.default;
  return cache.voice;
}
