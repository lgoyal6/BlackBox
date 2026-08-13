import type {
  CallTypeFamily,
  DecisionOutcome,
  GraphNode,
  Hit,
  IncidentDoc,
  IncidentState,
  InterruptPayload,
  ReclassPrior,
  SignatureMatch,
} from "@/lib/contracts";
import type { BlackboxEvent } from "@/lib/contracts";

export interface EmbeddingsPort {
  embed(texts: string[], inputType: "document" | "query"): Promise<number[][]>;
  embedOne(text: string, inputType?: "document" | "query"): Promise<number[]>;
  info(): { provider: string; model: string; dim: number };
}

export interface RetrievalPort {
  fanOut(query: string, opts?: { kPerSource?: number; limit?: number;
                                 callTypeFamily?: CallTypeFamily }): Promise<Hit[]>;
  signatureMatch(incident: IncidentDoc): Promise<SignatureMatch | null>;
  failureMemory(query: string, family?: CallTypeFamily): Promise<Hit[]>;
  reclassPrior(initialCallType: string, dispatchArea?: string): Promise<ReclassPrior | null>;
}

export interface MemoryPort {
  recordDecision(input: {
    incidentId: string;
    utterance: string;
    actionChosen: string;
    rationale: string;
    optionsConsidered?: string[];
    outcome?: DecisionOutcome;
  }): Promise<string>;
  updateOutcome(decisionId: string, outcome: DecisionOutcome): Promise<void>;
  generateAndWrite(incidentId: string): Promise<string>;
  draftPcr(incidentId: string): Promise<{ text: string }>;
}

export interface LlmPort {
  json<T>(prompt: string, schema: unknown, opts?: { model?: string }): Promise<T>;
  text(prompt: string, opts?: { model?: string; maxWords?: number }): Promise<string>;
}

export interface EventsPort {
  emit(e: Omit<BlackboxEvent, "seq" | "t" | "_id">): Promise<void>;
  recent(incidentId: string | null, n?: number): Promise<BlackboxEvent[]>;
}

export interface GraphPort {
  start(incidentId: string): Promise<{ interrupt: InterruptPayload | null }>;
  resume(incidentId: string, value: unknown): Promise<{ interrupt: InterruptPayload | null }>;
  state(incidentId: string): Promise<{ values: Partial<IncidentState>; next: string[];
                                       checkpointCount: number }>;
}

export interface VoicePort {
  speak(incidentId: string, text: string): Promise<void>;
  /** WebSocket session. Do not pass this url to a WebRTC startSession — that throws. */
  signedUrl(): Promise<{ url: string; agentId: string }>;
  /** WebRTC session token. This is what the operator console uses. */
  conversationToken(): Promise<{ token: string; agentId: string }>;
}

export type { GraphNode };
