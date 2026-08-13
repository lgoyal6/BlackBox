import { graph } from "@/lib/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/state/[incidentId]` — the graph thread's current values, frontier, and checkpoint count. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ incidentId: string }> },
): Promise<Response> {
  // Next.js 16: `params` is a Promise.
  const { incidentId } = await ctx.params;

  if (!incidentId || incidentId.trim() === "") {
    return Response.json({ error: "incidentId is required" }, { status: 400 });
  }

  try {
    // An unknown thread returns whatever the graph returns. No 404 on an empty state — the
    // dashboard may poll before `start` has run.
    const state = await graph().then((g) => g.state(incidentId));
    return Response.json(state, { status: 200 });
  } catch (err) {
    console.error(
      `[state] read failed ${incidentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
