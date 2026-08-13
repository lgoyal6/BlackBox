import type { GraphNode, Hit, IncidentStatus } from "./domain";

export interface EventBase {
  _id?: string;
  seq: number;
  incidentId: string | null;
  t: Date;
}

export type BlackboxEvent = EventBase & (
  | { kind: "status";     payload: { status: IncidentStatus; ref: string; label: string;
                                     dispatchArea: string; unit?: string;
                                     startedAt: Date } }
  | { kind: "node";       payload: { node: GraphNode; phase: "enter" | "exit" } }
  | { kind: "voice";      payload: { speaker: "medic" | "agent"; text: string;
                                     clock: string } }
  | { kind: "decision";   payload: { decisionId: string; actionChosen: string;
                                     rationaleRecorded: boolean; protocolConflict: boolean } }
  | { kind: "readback";   payload: { state: "awaiting" | "confirmed" | "rejected";
                                     readbackText: string } }
  | { kind: "retrieval";  payload: { query: string; hits: Hit[] } }
  | { kind: "write";      payload: { collection: string; count: number } }
  | { kind: "checkpoint"; payload: { count: number } }
  | { kind: "pcr";        payload: { postmortemId: string; preview: string } }
);
