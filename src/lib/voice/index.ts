import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { INCIDENTS, type IncidentDoc } from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { env } from "@/lib/env";
import type { VoicePort } from "@/lib/ports";
import { events } from "@/lib/registry";

type IncidentRecord = { [K in keyof IncidentDoc]: IncidentDoc[K] };

function client(): ElevenLabsClient {
  if (!env.elevenLabsApiKey) {
    throw new Error("ELEVENLABS_API_KEY not configured");
  }
  return new ElevenLabsClient({ apiKey: env.elevenLabsApiKey });
}

function agentId(): string {
  if (!env.elevenLabsAgentId) {
    throw new Error("ELEVENLABS_AGENT_ID not configured — run `npm run agent:setup`");
  }
  return env.elevenLabsAgentId;
}

/**
 * `speak` records; it does not push audio.
 *
 * With browser WebRTC the agent's audio is produced inside the ElevenLabs session, and
 * `@elevenlabs/elevenlabs-js` 2.63.0 exposes no server-side way to inject a message into a live
 * conversation — the `conversationalAi.conversations` client offers `getSignedUrl`,
 * `getWebrtcToken`, and read operations only. So this appends to the incident timeline and
 * emits a `voice` event, and returns.
 *
 * This looks like an omission and is not: **the brief is retrieved by a tool rather than pushed
 * by the server.** The agent speaks the result of `recall_memory` on its first turn, so nothing
 * in the demo depends on server-initiated speech.
 */
export async function speak(incidentId: string, text: string): Promise<void> {
  const now = new Date();
  try {
    await col<IncidentRecord>(INCIDENTS).updateOne(
      { incidentId },
      { $push: { timeline: { t: now, source: "agent", text } }, $set: { updatedAt: now } },
    );
  } catch (err) {
    console.error(
      `[voice] timeline append failed ${incidentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await (await events()).emit({
    kind: "voice",
    incidentId,
    payload: { speaker: "agent", text, clock: "" },
  });
}

/**
 * WebSocket session credential. **Do not hand this to a WebRTC `startSession`** — that throws in
 * `@elevenlabs/react` 1.12.0, whose `SessionConfig` types `signedUrl` and `conversationToken` as
 * mutually exclusive. `app/voice` uses `conversationToken` below.
 */
export async function signedUrl(): Promise<{ url: string; agentId: string }> {
  const id = agentId();
  const res = await client().conversationalAi.conversations.getSignedUrl({ agentId: id });
  return { url: res.signedUrl, agentId: id };
}

/** WebRTC session token. This is what the operator console uses. */
export async function conversationToken(): Promise<{ token: string; agentId: string }> {
  const id = agentId();
  const res = await client().conversationalAi.conversations.getWebrtcToken({ agentId: id });
  return { token: res.token, agentId: id };
}

const voiceAdapter: VoicePort = { speak, signedUrl, conversationToken };
const _check: VoicePort = voiceAdapter;
void _check;

export default voiceAdapter;
