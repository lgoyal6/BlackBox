import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "@langchain/langgraph";
import { col } from "@/lib/db/client";
import {
  CHECKPOINTS,
  INCIDENTS,
  PUBLIC_INCIDENT_PROJECTION,
  type IncidentDoc,
  type IncidentState,
  type InterruptPayload,
} from "@/lib/contracts";
import type { GraphPort } from "@/lib/ports";
import { getCompiledGraph } from "./compile";
import { interruptPayloadFromInvokeResult, threadConfig } from "./wrap";

let fixtureCache: IncidentDoc[] | null = null;

function reviveIncident(raw: Record<string, unknown>): IncidentDoc {
  const cad = raw.cad as Record<string, unknown>;
  const timeline = Array.isArray(raw.timeline) ? raw.timeline : [];
  return {
    ...(raw as unknown as IncidentDoc),
    cad: { ...(cad as object), incidentDatetime: new Date(cad.incidentDatetime as string) } as IncidentDoc["cad"],
    timeline: timeline.map((e: Record<string, unknown>) => ({ ...(e as object), t: new Date(e.t as string) })) as IncidentDoc["timeline"],
    createdAt: new Date(raw.createdAt as string),
    updatedAt: new Date(raw.updatedAt as string),
  };
}

function loadFixtureIncident(incidentId: string): IncidentDoc | null {
  if (!fixtureCache) {
    const raw = readFileSync(join(process.cwd(), "fixtures", "incidents.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>[];
    fixtureCache = parsed.map(reviveIncident);
  }
  return fixtureCache.find((i) => i.incidentId === incidentId) ?? null;
}

async function loadInitialState(incidentId: string): Promise<IncidentState> {
  const fromDb = await col<IncidentDoc>(INCIDENTS).findOne(
    { incidentId },
    { projection: PUBLIC_INCIDENT_PROJECTION },
  );
  const incident = fromDb ?? loadFixtureIncident(incidentId);
  if (!incident) {
    throw new Error(`graph: incident ${incidentId} not found in Atlas or fixtures/incidents.json`);
  }

  return {
    incidentId: incident.incidentId,
    displayId: incident.displayId,
    ref: incident.ref,
    status: incident.status,
    cad: incident.cad,
    callTypeFamily: incident.callTypeFamily,
    timeline: incident.timeline,
    nodeTrail: [],
    retrieved: [],
    decisionsRecorded: [],
    signature: null,
    plan: null,
    brief: null,
    pendingReadback: null,
    lastConfirmation: null,
    closeRequested: false,
  };
}

export async function start(incidentId: string): Promise<{ interrupt: InterruptPayload | null }> {
  const compiled = await getCompiledGraph();
  const initial = await loadInitialState(incidentId);
  const result = await compiled.invoke(initial, threadConfig(incidentId));
  return { interrupt: interruptPayloadFromInvokeResult(result) };
}

export async function resume(
  incidentId: string,
  value: unknown,
): Promise<{ interrupt: InterruptPayload | null }> {
  const compiled = await getCompiledGraph();
  const result = await compiled.invoke(new Command({ resume: value }), threadConfig(incidentId));
  return { interrupt: interruptPayloadFromInvokeResult(result) };
}

export async function state(incidentId: string): Promise<{
  values: Partial<IncidentState>;
  next: string[];
  checkpointCount: number;
}> {
  const compiled = await getCompiledGraph();
  const snapshot = await compiled.getState(threadConfig(incidentId));
  const checkpointCount = await col<{ thread_id: string }>(CHECKPOINTS).countDocuments({
    thread_id: incidentId,
  });
  return {
    values: (snapshot.values ?? {}) as Partial<IncidentState>,
    next: [...(snapshot.next ?? [])],
    checkpointCount,
  };
}

const graph: GraphPort = { start, resume, state };
export default graph;
