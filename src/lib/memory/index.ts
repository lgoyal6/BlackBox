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

async function loadIncident(incidentId: string): Promise<IncidentDoc> {
  const doc = await col<IncidentDoc>(INCIDENTS).findOne(
    { incidentId },
    { projection: PUBLIC_INCIDENT_PROJECTION },
  );
  if (!doc) throw new Error(`memory: incident ${incidentId} not found`);
  return doc;
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
