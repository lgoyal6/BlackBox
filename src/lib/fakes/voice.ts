import { env } from "@/lib/env";
import type { VoicePort } from "@/lib/ports";

async function speak(incidentId: string, text: string): Promise<void> {
  console.log(`[fake voice] incident=${incidentId} speak=${text}`);
}

async function signedUrl(): Promise<{ url: string; agentId: string }> {
  return {
    url: "wss://fake.elevenlabs.io/v1/convai/conversation",
    agentId: env.elevenLabsAgentId || "agent_fake",
  };
}

async function conversationToken(): Promise<{ token: string; agentId: string }> {
  return {
    token: "fake-conversation-token",
    agentId: env.elevenLabsAgentId || "agent_fake",
  };
}

const voice: VoicePort = { speak, signedUrl, conversationToken };
export default voice;
