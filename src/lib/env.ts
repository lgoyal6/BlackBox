import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

loadDotenv({ path: resolve(process.cwd(), ".env") });
loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function str(key: string, fallback = ""): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} must be a finite number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

const EMBEDDING_DIM_BY_MODEL: Record<string, number> = {
  "voyage-3-large": 1024,
  "voyage-3.5": 1024,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export const env = {
  mongodbUri: str("MONGODB_URI"),
  mongodbDb: str("MONGODB_DB", "blackbox"),
  embeddingProvider: str("EMBEDDING_PROVIDER", "voyage"),
  embeddingModel: str("EMBEDDING_MODEL", "voyage-3-large"),
  embeddingDim: num("EMBEDDING_DIM", 1024),
  voyageApiKey: str("VOYAGE_API_KEY"),
  openaiApiKey: str("OPENAI_API_KEY"),
  llmModel: str("LLM_MODEL", "gpt-4.1-mini"),
  elevenLabsApiKey: str("ELEVENLABS_API_KEY"),
  elevenLabsAgentId: str("ELEVENLABS_AGENT_ID"),
  elevenLabsVoiceId: str("ELEVENLABS_VOICE_ID"),
  publicBaseUrl: str("PUBLIC_BASE_URL"),
  toolSharedSecret: str("TOOL_SHARED_SECRET"),
  triggerMode: str("TRIGGER_MODE", "changestream"),
  socrataAppToken: str("SOCRATA_APP_TOKEN"),
  twilioAccountSid: str("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: str("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: str("TWILIO_PHONE_NUMBER"),
  demoMedicPhone: str("DEMO_MEDIC_PHONE"),
} as const;

export function assertEmbeddingConfig(): void {
  const required = EMBEDDING_DIM_BY_MODEL[env.embeddingModel];
  if (required === undefined) {
    throw new Error(
      `Unknown EMBEDDING_MODEL ${JSON.stringify(env.embeddingModel)}. ` +
      `Known models: ${Object.keys(EMBEDDING_DIM_BY_MODEL).join(", ")}`,
    );
  }
  if (required !== env.embeddingDim) {
    throw new Error(
      `EMBEDDING_MODEL ${env.embeddingModel} requires EMBEDDING_DIM=${required}, ` +
      `got ${env.embeddingDim}. A mismatch returns empty vector search results with no error.`,
    );
  }
}

assertEmbeddingConfig();
