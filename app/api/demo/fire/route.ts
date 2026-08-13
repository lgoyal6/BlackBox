import { DemoFireReq } from "@/lib/contracts";
import { CloneError, cloneLiveIncident } from "../_lib/clone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /api/demo/fire` — clone a historical incident into a live one and start the graph. */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    const raw = await req.text();
    body = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const parsed = DemoFireReq.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  try {
    const result = await cloneLiveIncident(parsed.data.pattern, parsed.data.incidentId);
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof CloneError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error(
      `[demo] fire failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
