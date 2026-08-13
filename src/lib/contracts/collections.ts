export const INCIDENTS = "incidents";
export const DECISIONS = "decisions";
export const REMEDIATIONS = "remediations";
export const RUNBOOKS = "runbooks";
export const POSTMORTEMS = "postmortems";
export const EVENTS = "events";
export const CHECKPOINTS = "checkpoints";
export const CHECKPOINT_WRITES = "checkpoint_writes";
export const EMBED_CACHE = "_embed_cache";
export const WATCH_STATE = "_watch_state";

export const VECTOR_COLLECTIONS = [DECISIONS, REMEDIATIONS, RUNBOOKS, POSTMORTEMS] as const;
/** The three-source fan-out pipeline. Order matters: index 0 is the base collection. Remediations are queried separately by failureMemory — they are not part of this union. */
export const FAN_OUT_COLLECTIONS = [DECISIONS, POSTMORTEMS, RUNBOOKS] as const;

export const vectorIndexName = (coll: string) => `vs_${coll}`;
export const VECTOR_PATH = "embedding";

export const SOCRATA_BASE = "https://data.cityofnewyork.us/resource/76xm-jjuj.json";
export const SOCRATA_YEAR_FLOOR = "2024-01-01T00:00:00";

/** Row downloads. Four requests, ~180 documents, never paged past these limits. */
export const DEMO_SLICES = [
  { name: "arrest", where: "initial_call_type='UNC' AND final_call_type='ARREST' AND incident_datetime>'2024-01-01T00:00:00'", limit: 40 },
  { name: "cardiac", where: "initial_call_type='SICK' AND final_call_type='CARD' AND incident_datetime>'2024-01-01T00:00:00'", limit: 40 },
  { name: "divergent", where: "initial_call_type!=final_call_type AND incident_datetime>'2024-01-01T00:00:00'", limit: 80 },
  { name: "control", where: "initial_call_type=final_call_type AND incident_datetime>'2024-01-01T00:00:00'", limit: 20 },
] as const;

export const SEED_TARGET = 40;
export const SEED_DEFAULT_TEMPLATED = true;
export const SEED_STRATA = { uncArrest: 15, sickCard: 15, other: 10 } as const;
export const CURATED_POSTMORTEM_CAP = 3;
export const REMEDIATION_FAILURE_FLOOR = 10;

export const RUNBOOK_CHAPTER_FILTER = [
  "Cardiovascular", "Cardiac", "Airway", "Respiratory", "Altered",
  "Toxicology", "Overdose", "Field Triage",
] as const;
