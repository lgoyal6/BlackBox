import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { col } from "@/lib/db/client";
import {
  DECISIONS,
  INCIDENTS,
  POSTMORTEMS,
  PUBLIC_INCIDENT_PROJECTION,
  type DecisionDoc,
  type DecisionOutcome,
  type IncidentDoc,
  type PostmortemDoc,
} from "@/lib/contracts";
import type { MemoryPort } from "@/lib/ports";
import { recordDecision as recordDecisionInner } from "./decisions";
import { generateAndWrite as generateAndWriteInner } from "./postmortem";
import { draftPcr as draftPcrInner, renderPcrText } from "./epcr";

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

/** Atlas first; falls back to fixtures/incidents.json so graph:local/drill can reach postmortem before PHASE-04 ingestion exists. */
function loadFixtureIncident(incidentId: string): IncidentDoc | null {
  if (!fixtureCache) {
    const raw = readFileSync(join(process.cwd(), "fixtures", "incidents.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>[];
    fixtureCache = parsed.map(reviveIncident);
  }
  return fixtureCache.find((i) => i.incidentId === incidentId) ?? null;
}

async function loadIncident(incidentId: string): Promise<IncidentDoc> {
  const doc = await col<IncidentDoc>(INCIDENTS).findOne(
    { incidentId },
    { projection: PUBLIC_INCIDENT_PROJECTION },
  );
  const incident = doc ?? loadFixtureIncident(incidentId);
  if (!incident) throw new Error(`memory: incident ${incidentId} not found in Atlas or fixtures/incidents.json`);
  return incident;
}

async function loadDecisions(incidentId: string): Promise<DecisionDoc[]> {
  return col<DecisionDoc>(DECISIONS).find({ incidentId }).sort({ t: 1 }).toArray();
}

async function recordDecision(input: {
  incidentId: string;
  utterance: string;
  actionChosen: string;
  rationale: string;
  optionsConsidered?: string[];
  outcome?: DecisionOutcome;
}): Promise<string> {
  const incident = await loadIncident(input.incidentId);
  const written = await recordDecisionInner({
    incidentId: input.incidentId,
    displayId: incident.displayId,
    utterance: input.utterance,
    actionChosen: input.actionChosen,
    rationale: input.rationale,
    optionsConsidered: input.optionsConsidered,
    outcome: input.outcome,
    callTypeFamily: incident.callTypeFamily,
  });
  return written.insertedId;
}

async function updateOutcome(decisionId: string, outcome: DecisionOutcome): Promise<void> {
  await col<DecisionDoc>(DECISIONS).updateOne({ _id: new ObjectId(decisionId) }, { $set: { outcome } });
}

async function generateAndWrite(incidentId: string): Promise<string> {
  const incident = await loadIncident(incidentId);
  const decisions = await loadDecisions(incidentId);
  const written = await generateAndWriteInner(incident, decisions);
  return written.insertedId;
}

async function draftPcr(incidentId: string): Promise<{ text: string }> {
  const incident = await loadIncident(incidentId);
  const decisions = await loadDecisions(incidentId);
  const postmortem = await col<PostmortemDoc>(POSTMORTEMS).findOne(
    { incidentId, origin: "live" },
    { sort: { t: -1 } },
  );
  const draft = draftPcrInner(incident, decisions, postmortem ?? undefined);
  return { text: renderPcrText(draft) };
}

const memory: MemoryPort = { recordDecision, updateOutcome, generateAndWrite, draftPcr };
export default memory;
