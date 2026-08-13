import { loadLiveCorpus } from "./_lib/load-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/corpus` — historical incidents, reports, remediations, and Voyage embedding info. */
export async function GET(): Promise<Response> {
  const bundle = await loadLiveCorpus();
  const status = bundle.error !== null && bundle.incidents.length === 0 ? 503 : 200;
  return Response.json(bundle, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
