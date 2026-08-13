import { GRAPH_NODE_ORDER, type GraphNode, type IncidentState, type InterruptPayload } from "@/lib/contracts";
import type { GraphPort } from "@/lib/ports";

type Session = {
  passedGate: boolean;
  trail: GraphNode[];
  checkpointCount: number;
};

const sessions = new Map<string, Session>();

function getSession(incidentId: string): Session {
  const existing = sessions.get(incidentId);
  if (existing) return existing;
  const created: Session = { passedGate: false, trail: [], checkpointCount: 0 };
  sessions.set(incidentId, created);
  return created;
}

function readbackInterrupt(incidentId: string): InterruptPayload {
  return {
    type: "readback",
    incidentId,
    utterance: "epinephrine 1 milligram IV push",
    readbackText: "Confirming epinephrine, 1 milligram, IV push. Say confirm.",
    fields: { drug: "epinephrine", dose: "1 milligram", route: "IV push" },
  };
}

async function start(incidentId: string): Promise<{ interrupt: InterruptPayload | null }> {
  const session = getSession(incidentId);
  session.trail = [];
  session.passedGate = false;
  for (const node of GRAPH_NODE_ORDER) {
    session.trail.push(node);
    session.checkpointCount += 1;
    if (node === "readback_gate") {
      return { interrupt: readbackInterrupt(incidentId) };
    }
  }
  return { interrupt: null };
}

async function resume(
  incidentId: string,
  _value: unknown,
): Promise<{ interrupt: InterruptPayload | null }> {
  const session = getSession(incidentId);
  if (!session.passedGate) {
    session.passedGate = true;
    const gate = GRAPH_NODE_ORDER.indexOf("readback_gate");
    session.trail.push(...GRAPH_NODE_ORDER.slice(gate + 1));
    session.checkpointCount += GRAPH_NODE_ORDER.length - gate;
    return { interrupt: null };
  }
  return { interrupt: null };
}

async function state(incidentId: string): Promise<{
  values: Partial<IncidentState>;
  next: string[];
  checkpointCount: number;
}> {
  const session = getSession(incidentId);
  const current = session.trail[session.trail.length - 1];
  const next = session.passedGate
    ? []
    : current
      ? [current]
      : ["triage"];
  return {
    values: {
      incidentId,
      nodeTrail: session.trail,
      pendingReadback: session.passedGate
        ? null
        : {
            utterance: "epinephrine 1 milligram IV push",
            readbackText: "Confirming epinephrine, 1 milligram, IV push. Say confirm.",
            fields: { drug: "epinephrine", dose: "1 milligram", route: "IV push" },
          },
    },
    next,
    checkpointCount: session.checkpointCount,
  };
}

const graph: GraphPort = { start, resume, state };
export default graph;
