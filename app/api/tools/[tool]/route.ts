import { requireSecret } from "../_lib/auth";
import { handleTool } from "../_lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Single dispatcher for the seven ElevenLabs server tools. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ tool: string }> },
): Promise<Response> {
  // Secret first: a 401 must not depend on a valid JSON payload.
  const denied = requireSecret(req);
  if (denied) return denied;

  // Next.js 16: `params` is a Promise. A copied Next 14/15 signature will not compile.
  const { tool } = await ctx.params;

  let body: unknown;
  try {
    const raw = await req.text();
    body = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  try {
    const { status, json } = await handleTool(tool, body);
    return Response.json(json, { status });
  } catch (err) {
    // Log the detail, return none of it — no stack traces over the tunnel.
    console.error(
      `[tool] ${tool} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
