import { Annotation } from "@langchain/langgraph";
import type {
  CadFields,
  CallTypeFamily,
  GraphNode,
  Hit,
  IncidentStatus,
  PendingReadback,
  PlanResult,
  ReadbackConfirmation,
  SignatureMatch,
  TimelineEntry,
} from "@/lib/contracts";

export function concatReducer<T>(left: T[], right: T | T[]): T[] {
  const additions = Array.isArray(right) ? right : [right];
  return [...(left ?? []), ...additions];
}

export const IncidentAnnotation = Annotation.Root({
  incidentId: Annotation<string>,
  displayId: Annotation<string>,
  ref: Annotation<string>,
  status: Annotation<IncidentStatus>,
  cad: Annotation<CadFields>,
  callTypeFamily: Annotation<CallTypeFamily>,
  timeline: Annotation<TimelineEntry[]>({ reducer: concatReducer, default: () => [] }),
  nodeTrail: Annotation<GraphNode[]>({ reducer: concatReducer, default: () => [] }),
  retrieved: Annotation<Hit[]>({ reducer: concatReducer, default: () => [] }),
  decisionsRecorded: Annotation<string[]>({ reducer: concatReducer, default: () => [] }),
  signature: Annotation<SignatureMatch | null>,
  plan: Annotation<PlanResult | null>,
  brief: Annotation<string | null>,
  pendingReadback: Annotation<PendingReadback | null>,
  lastConfirmation: Annotation<ReadbackConfirmation | null>,
  closeRequested: Annotation<boolean>,
});

export type GraphState = typeof IncidentAnnotation.State;
