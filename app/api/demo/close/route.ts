import {
  DemoCloseReq,
  INCIDENTS,
  PUBLIC_INCIDENT_PROJECTION,
  labelFor,
  type IncidentDoc,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { events } from "@/lib/registry";

/**
 * The driver's generic requires an index signature, which an `interface` never gets
 * implicitly. Mapping over `IncidentDoc` produces a type alias that does, without restating a
 * single field or widening one.
 */
type IncidentRecord = { [K in keyof IncidentDoc]: IncidentDoc[K] };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /api/demo/close` — mark a live incident closed and tell the dashboard. */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    const raw = await req.text();
    body = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const parsed = DemoCloseReq.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const { incidentId } = parsed.data;

  try {
    const now = new Date();
    const updated = await col<IncidentRecord>(INCIDENTS).findOneAndUpdate(
      { incidentId },
      { $set: { status: "closed", updatedAt: now } },
      { returnDocument: "after", projection: PUBLIC_INCIDENT_PROJECTION },
    );

    if (!updated) {
      return Response.json({ error: "incident not found" }, { status: 404 });
    }

    await (await events()).emit({
      kind: "status",
      incidentId,
      payload: {
        status: "closed",
        ref: updated.ref,
        label: labelFor(updated.cad.initialCallType),
        dispatchArea: updated.cad.dispatchArea,
        unit: updated.cad.unit,
        startedAt: new Date(updated.createdAt),
      },
    });

    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error(`[demo] close failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
