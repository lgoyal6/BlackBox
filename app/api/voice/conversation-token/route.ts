import { conversationToken } from "@/lib/voice/index";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/voice/conversation-token` — WebRTC session token. This is the route `app/voice`
 * calls; a signed URL passed to `startSession({ connectionType: "webrtc" })` throws.
 *
 * The route is a thin wrapper over `VoicePort.conversationToken` so there is one minting path
 * per credential rather than two that can drift. It accepts and echoes nothing from the client:
 * its only job is keeping `ELEVENLABS_API_KEY` server-side.
 */
export async function GET(): Promise<Response> {
  if (!env.elevenLabsApiKey) {
    return Response.json({ error: "ELEVENLABS_API_KEY not configured" }, { status: 500 });
  }

  try {
    return Response.json(await conversationToken(), { status: 200 });
  } catch (err) {
    // The provider's status code, never its body.
    const status = (err as { statusCode?: number })?.statusCode;
    console.error(
      `[voice] conversation token mint failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json(
      { error: `conversation token mint failed${status ? ` (provider status ${status})` : ""}` },
      { status: 500 },
    );
  }
}
