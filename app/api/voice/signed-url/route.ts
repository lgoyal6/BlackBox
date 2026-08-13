import { signedUrl } from "@/lib/voice/index";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/voice/signed-url` — WebSocket session credential, and `VoicePort` completeness.
 * The locked transport is WebRTC, so the operator console uses `/api/voice/conversation-token`
 * instead; these two are not interchangeable.
 *
 * Accepts and echoes nothing from the client: its only job is keeping `ELEVENLABS_API_KEY`
 * server-side.
 */
export async function GET(): Promise<Response> {
  if (!env.elevenLabsApiKey) {
    return Response.json({ error: "ELEVENLABS_API_KEY not configured" }, { status: 500 });
  }

  try {
    return Response.json(await signedUrl(), { status: 200 });
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    console.error(
      `[voice] signed url mint failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json(
      { error: `signed url mint failed${status ? ` (provider status ${status})` : ""}` },
      { status: 500 },
    );
  }
}
