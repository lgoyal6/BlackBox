export type IncidentStatus = "dispatched" | "en_route" | "on_scene" | "transporting" | "closed";
export type CallTypeFamily =
  | "cardiac" | "respiratory" | "altered" | "trauma" | "behavioral" | "general" | "other";
export type DecisionOutcome = "pending" | "worked" | "failed" | "unknown";
export type RemediationOutcome = "success" | "failure";
export type MemoryOrigin = "seeded" | "curated" | "live";
export type TimelineSource = "medic" | "agent" | "system";
export type RetrievalSource = "decisions" | "postmortems" | "runbooks" | "remediations";
export type GraphNode =
  | "triage" | "signature_match" | "brief" | "plan" | "readback_gate"
  | "execute_record" | "verify" | "record_decision" | "await_input" | "postmortem";

export const GRAPH_NODE_ORDER: GraphNode[] = [
  "triage", "signature_match", "brief", "plan", "readback_gate",
  "execute_record", "verify", "record_decision", "await_input", "postmortem",
];

/** Footer pills in reference.png. Every GraphNode maps to exactly one stage. */
export const GRAPH_STAGES = [
  { id: "triage",   label: "triage",        nodes: ["triage"] },
  { id: "recall",   label: "recall",        nodes: ["signature_match", "brief", "plan"] },
  { id: "readback", label: "readback gate", nodes: ["readback_gate", "await_input"] },
  { id: "record",   label: "record",        nodes: ["execute_record", "verify", "record_decision", "postmortem"] },
] as const;

const FAMILY_CODES: Record<Exclude<CallTypeFamily, "other">, readonly string[]> = {
  cardiac: ["CARD", "CARDBR", "ARREST", "CVAC"],
  respiratory: ["DIFFBR", "ASTHMB", "RESPIR"],
  altered: ["UNC", "UNKNOW", "DRUG", "EDPC"],
  trauma: ["INJURY", "INJMAJ", "SHOT", "STAB"],
  behavioral: ["EDP", "EDPM"],
  general: ["SICK", "OBLABR", "ABDPN"],
};

export function callTypeFamily(code: string): CallTypeFamily {
  const upper = code.toUpperCase();
  for (const [family, codes] of Object.entries(FAMILY_CODES) as [Exclude<CallTypeFamily, "other">, readonly string[]][]) {
    if (codes.includes(upper)) return family;
  }
  return "other";
}

export const CODE_LABELS: Record<string, string> = {
  UNC: "unconscious or unresponsive",
  ARREST: "cardiac arrest",
  CARD: "cardiac condition",
  CARDBR: "cardiac condition with breathing difficulty",
  SICK: "general illness",
  DRUG: "drug overdose",
  EDP: "emotionally disturbed person",
  EDPC: "emotionally disturbed person, combative",
  EDPM: "emotionally disturbed person, medical",
  INJURY: "injury",
  INJMAJ: "major injury",
  DIFFBR: "difficulty breathing",
  UNKNOW: "unknown condition",
  CVAC: "possible stroke",
  ASTHMB: "asthma",
  OBLABR: "obstetric labor",
  ABDPN: "abdominal pain",
  SHOT: "gunshot wound",
  STAB: "stab wound",
  RESPIR: "respiratory arrest",
};

/** Falls back to a humanized version of the raw code; never returns the bare code. */
export function labelFor(code: string): string {
  const mapped = CODE_LABELS[code] ?? CODE_LABELS[code.toUpperCase()];
  if (mapped) return mapped;
  const humanized = code
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!humanized) return "unknown condition";
  if (humanized === code) return `${humanized} condition`;
  return humanized;
}

export interface TimelineEntry {
  t: Date;
  source: TimelineSource;
  text: string;
  kind?: "narration" | "question" | "readback" | "confirmation" | "system";
}

export interface CadFields {
  initialCallType: string;
  initialSeverityLevelCode: number;
  borough: string;
  zipcode: string;
  dispatchArea: string;
  unit?: string;
  incidentDatetime: Date;
}

/** QUARANTINED. No graph node, retrieval path, or voice tool may read this. */
export interface GroundTruth {
  finalCallType: string;
  finalSeverityLevelCode: number;
  severityDelta: number;
  incidentCloseDatetime: Date | null;
  incidentDispositionCode: string | null;
  reopenIndicator: boolean;
  dispatchResponseSeconds: number | null;
  incidentResponseSeconds: number | null;
  incidentTravelSeconds: number | null;
  /** Derived, never stored as a Socrata field: response + travel, falling back to response alone. Used for costMinutes. */
  incidentTotalSeconds?: number | null;
}

export interface IncidentDoc {
  incidentId: string;
  displayId: string;
  ref: string;
  status: IncidentStatus;
  cad: CadFields;
  callTypeFamily: CallTypeFamily;
  timeline: TimelineEntry[];
  isLive: boolean;
  _groundTruth?: GroundTruth;
  createdAt: Date;
  updatedAt: Date;
}

/** Projection every agent-facing read MUST use. */
export const PUBLIC_INCIDENT_PROJECTION = { _groundTruth: 0 } as const;

export interface DecisionDoc {
  incidentId: string;
  displayId: string;
  utterance: string;
  actionChosen: string;
  rationale: string;
  optionsConsidered: string[];
  outcome: DecisionOutcome;
  protocolConflict: boolean;
  callTypeFamily: CallTypeFamily;
  embedding: number[];
  embeddedText: string;
  t: Date;
}

export interface RemediationDoc {
  incidentId: string;
  action: string;
  outcome: RemediationOutcome;
  durationSeconds: number | null;
  costMinutes: number | null;
  sideEffects: string[];
  origin: MemoryOrigin;
  callTypeFamily: CallTypeFamily;
  embedding: number[];
  embeddedText: string;
  t: Date;
}

export interface RunbookDoc {
  source: "NASEMSO-2022-v3";
  sectionTitle: string;
  sectionPath: string[];
  text: string;
  pageStart: number;
  pageEnd: number;
  chunkIndex: number;
  embedding: number[];
  embeddedText: string;
}

export interface PostmortemDoc {
  incidentId: string;
  displayId: string;
  narrative: string;
  whatChanged: string;
  severityDelta: number;
  lessons: string[];
  origin: MemoryOrigin;
  callTypeFamily: CallTypeFamily;
  embedding: number[];
  embeddedText: string;
  t: Date;
}

export interface Hit {
  source: RetrievalSource;
  docId: string;
  score: number;
  rank: number;
  rrf: number;
  title: string;
  text: string;
  spoken: string;
  displayId: string | null;
  meta: Record<string, unknown>;
}

export interface SignatureMatch {
  hits: Hit[];
  summary: string;
  displayId: string;
  confidence: number;
}

export interface ExcludedPath {
  path: string;
  why: string;
  sourceDisplayId: string;
  costMinutes: number | null;
}

export interface PlanResult {
  steps: { action: string; why: string }[];
  excludedPaths: ExcludedPath[];
}

/** Powers the brief line: "this call type in B3 reclassifies to cardiac 18% of the time overnight." */
export interface ReclassPrior {
  initialCallType: string;
  dispatchArea: string | null;
  nightOnly: boolean;
  sampleSize: number;
  top: { finalCallType: string; family: CallTypeFamily; pct: number; n: number }[];
}

export const SIGNATURE_MATCH_FLOOR = 0.62;
export const RRF_K = 60;
export const SOURCE_WEIGHTS: Record<RetrievalSource, number> = {
  decisions: 1.3, remediations: 1.25, postmortems: 1.2, runbooks: 1.0,
};
export const SPOKEN_WORD_CAP = 40;

export interface IncidentState {
  incidentId: string;
  displayId: string;
  ref: string;
  status: IncidentStatus;
  cad: CadFields;
  callTypeFamily: CallTypeFamily;
  timeline: TimelineEntry[];
  nodeTrail: GraphNode[];
  retrieved: Hit[];
  decisionsRecorded: string[];
  signature: SignatureMatch | null;
  plan: PlanResult | null;
  brief: string | null;
  pendingReadback: PendingReadback | null;
  lastConfirmation: ReadbackConfirmation | null;
  closeRequested: boolean;
}

export interface PendingReadback {
  utterance: string;
  readbackText: string;
  fields: { drug?: string; dose?: string; route?: string; [k: string]: string | undefined };
}

export interface ReadbackConfirmation { confirmed: boolean; verbatimOk: boolean }

export type InterruptPayload =
  | ({ type: "readback"; incidentId: string } & PendingReadback)
  | { type: "await_input"; incidentId: string; status: IncidentStatus };
