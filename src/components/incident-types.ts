import type { CallTypeFamily, MemoryOrigin, RemediationOutcome } from "@/lib/contracts";

/**
 * Plain, serialisable shapes for the incidents tab. No Dates and no ObjectIds, because
 * these cross the server/client boundary as props.
 */

export interface IncidentSummary {
  incidentId: string;
  displayId: string;
  ref: string;
  initialCallType: string;
  initialLabel: string;
  finalCallType: string | null;
  finalLabel: string | null;
  borough: string;
  dispatchArea: string;
  unit: string | null;
  family: CallTypeFamily;
  responseSeconds: number | null;
  /**
   * `initialSeverity - finalSeverity` as stored on the incident.
   * Positive means the call was upgraded after arrival (undertriaged).
   */
  severityDelta: number | null;
  reopened: boolean;
  /** The final call type differed from dispatch. This is the labelled triage error. */
  reclassified: boolean;
  hasReport: boolean;
}

export interface IncidentReport {
  incidentId: string;
  displayId: string;
  narrative: string;
  whatChanged: string;
  lessons: string[];
  origin: MemoryOrigin;
}

export interface IncidentRemediation {
  action: string;
  outcome: RemediationOutcome;
  costMinutes: number | null;
  sideEffects: string[];
  origin: MemoryOrigin;
}

export interface CorpusStats {
  incidents: number;
  reclassified: number;
  undertriaged: number;
  reports: number;
  failures: number;
  runbookSections: number;
}

export interface EmbeddingInfo {
  provider: string;
  model: string;
  dim: number;
}

export interface IncidentBundle {
  incidents: IncidentSummary[];
  /** Keyed by incidentId. */
  reports: Record<string, IncidentReport>;
  /** Keyed by incidentId. */
  remediations: Record<string, IncidentRemediation[]>;
  stats: CorpusStats;
  /** Non-null when the corpus could not be loaded; the tab renders this instead. */
  error: string | null;
  source: "live" | "snapshot";
  /** Newest `isLive: true` incident, if any. Drives the live-call tab when the URL has no id. */
  liveIncidentId: string | null;
  embedding: EmbeddingInfo | null;
}

export const EMPTY_BUNDLE: IncidentBundle = {
  incidents: [],
  reports: {},
  remediations: {},
  stats: {
    incidents: 0,
    reclassified: 0,
    undertriaged: 0,
    reports: 0,
    failures: 0,
    runbookSections: 0,
  },
  error: null,
  source: "snapshot",
  liveIncidentId: null,
  embedding: null,
};
