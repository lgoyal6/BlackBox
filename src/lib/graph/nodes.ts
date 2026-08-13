import { interrupt } from "@langchain/langgraph";
import { events, llm, memory, retrieval } from "@/lib/registry";
import {
  CODE_LABELS,
  labelFor,
  type ExcludedPath,
  type IncidentDoc,
  type IncidentState,
  type InterruptPayload,
  type PendingReadback,
  type ReadbackConfirmation,
  type TimelineEntry,
} from "@/lib/contracts";

const DOSE = /\d+\s*(mg|mcg|mL|g)\b/i;
const BRIEF_WORD_CAP = 55;
const MEDIC_HISTORY_LINES = 3;

function replaceRawCodes(text: string): string {
  return Object.keys(CODE_LABELS).reduce(
    (acc, code) => acc.replace(new RegExp(`\\b${code}\\b`, "g"), labelFor(code)),
    text,
  );
}

function capWords(text: string, cap: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= cap ? words.join(" ") : words.slice(0, cap).join(" ");
}

export async function triage(state: IncidentState): Promise<Partial<IncidentState>> {
  const status = state.status === "dispatched" ? "en_route" : state.status;
  return { status, nodeTrail: ["triage"] };
}

export async function signatureMatchNode(state: IncidentState): Promise<Partial<IncidentState>> {
  const incidentDoc: IncidentDoc = {
    incidentId: state.incidentId,
    displayId: state.displayId,
    ref: state.ref,
    status: state.status,
    cad: state.cad,
    callTypeFamily: state.callTypeFamily,
    timeline: state.timeline,
    isLive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const signature = await (await retrieval()).signatureMatch(incidentDoc);
  const query = `${labelFor(state.cad.initialCallType)} in ${state.cad.dispatchArea}, ${state.cad.borough}`;

  await (await events()).emit({
    kind: "retrieval",
    incidentId: state.incidentId,
    payload: { query, hits: signature?.hits ?? [] },
  });

  return {
    signature,
    retrieved: signature?.hits ?? [],
    nodeTrail: ["signature_match"],
  };
}

export async function brief(state: IncidentState): Promise<Partial<IncidentState>> {
  const label = labelFor(state.cad.initialCallType);
  let text: string;

  if (!state.signature) {
    text = `Dispatched as ${label} in ${state.cad.dispatchArea}; new signature, no prior history.`;
  } else {
    text = `Dispatched as ${label} in ${state.cad.dispatchArea}. This resembles incident ${state.signature.displayId}: ${state.signature.summary}`;
    const prior = await (await retrieval()).reclassPrior(state.cad.initialCallType, state.cad.dispatchArea);
    const top = prior?.top?.[0];
    if (top) {
      text += ` This call type in ${state.cad.dispatchArea} reclassifies to ${labelFor(top.finalCallType)} ${top.pct}% of the time.`;
    }
  }

  text = replaceRawCodes(text);
  text = capWords(text, BRIEF_WORD_CAP);

  return { brief: text, nodeTrail: ["brief"] };
}

function buildLogisticsSteps(excludedPaths: ExcludedPath[]): { action: string; why: string }[] {
  const steps: { action: string; why: string }[] = [
    { action: "confirm receiving facility status before committing", why: "documentation only" },
    { action: "read back the stated dose and route", why: "aviation-style confirmation before recording" },
  ];
  if (excludedPaths.length > 0) {
    steps.push({
      action: "record the airway decision and rationale",
      why: `avoid repeating a known-bad path: ${excludedPaths[0].path}`,
    });
  }
  return steps;
}

export async function plan(state: IncidentState): Promise<Partial<IncidentState>> {
  const recentMedic = state.timeline
    .filter((e) => e.source === "medic")
    .slice(-MEDIC_HISTORY_LINES)
    .map((e) => e.text)
    .join(" ");
  const query = [labelFor(state.cad.initialCallType), state.cad.borough, state.cad.dispatchArea, recentMedic]
    .filter(Boolean)
    .join(" ");

  let hits = await (await retrieval()).failureMemory(query, state.callTypeFamily);
  if (hits.length === 0) {
    hits = await (await retrieval()).failureMemory(query);
  }

  const excludedPaths: ExcludedPath[] = hits.map((h) => ({
    path: h.title,
    why: (h.spoken || h.text).slice(0, 200),
    sourceDisplayId: h.displayId ?? "unknown",
    costMinutes: typeof h.meta.costMinutes === "number" ? h.meta.costMinutes : null,
  }));
  if (excludedPaths.length === 0) {
    console.warn("plan: excludedPaths empty for query:", query);
  }

  const rawSteps = buildLogisticsSteps(excludedPaths);
  const filteredSteps = rawSteps.filter((s) => !DOSE.test(s.action) && !DOSE.test(s.why));
  const steps =
    filteredSteps.length > 0
      ? filteredSteps
      : [{ action: "record the medic's stated actions and rationale", why: "documentation only" }];

  return { plan: { steps, excludedPaths }, nodeTrail: ["plan"] };
}

function derivePending(state: IncidentState): PendingReadback {
  if (state.pendingReadback) return state.pendingReadback;
  const lastMedic = [...state.timeline].reverse().find((e) => e.source === "medic");
  if (lastMedic) {
    return {
      utterance: lastMedic.text,
      readbackText: `Confirming: ${lastMedic.text}. Say confirm.`,
      fields: {},
    };
  }
  return {
    utterance: "",
    readbackText: "No medic statement recorded yet. Confirming a documentation-only checkpoint. Say confirm.",
    fields: {},
  };
}

export async function readbackGate(state: IncidentState): Promise<Partial<IncidentState>> {
  const pending = derivePending(state);
  const payload: InterruptPayload = { type: "readback", incidentId: state.incidentId, ...pending };
  const confirmation = interrupt(payload) as ReadbackConfirmation;

  await (await events()).emit({
    kind: "readback",
    incidentId: state.incidentId,
    payload: {
      state: confirmation.confirmed ? "confirmed" : "rejected",
      readbackText: pending.readbackText,
    },
  });

  return { lastConfirmation: confirmation, pendingReadback: null };
}

export async function executeRecord(_state: IncidentState): Promise<Partial<IncidentState>> {
  const entry: TimelineEntry = {
    t: new Date(),
    source: "system",
    text: "Stated action recorded. The agent does not perform clinical actions.",
    kind: "system",
  };
  return { timeline: [entry], nodeTrail: ["execute_record"] };
}

export async function verify(state: IncidentState): Promise<Partial<IncidentState>> {
  const ok = state.lastConfirmation?.verbatimOk === true;
  const entry: TimelineEntry = {
    t: new Date(),
    source: "system",
    text: ok
      ? "Readback verified verbatim."
      : "Readback not confirmed verbatim; medic retains clinical authority.",
    kind: "system",
  };
  return { timeline: [entry], nodeTrail: ["verify"] };
}

export async function recordDecisionNode(state: IncidentState): Promise<Partial<IncidentState>> {
  const lastMedic = [...state.timeline].reverse().find((e) => e.source === "medic");
  const utterance = state.pendingReadback?.utterance ?? lastMedic?.text ?? "";

  if (!utterance.trim()) {
    return { nodeTrail: ["record_decision"] };
  }

  try {
    const decisionId = await (await memory()).recordDecision({
      incidentId: state.incidentId,
      utterance,
      actionChosen: utterance,
      rationale: utterance,
    });
    return { decisionsRecorded: [decisionId], nodeTrail: ["record_decision"] };
  } catch (err) {
    console.warn("recordDecisionNode: recordDecision failed —", err instanceof Error ? err.message : err);
    return { nodeTrail: ["record_decision"] };
  }
}

export async function awaitInput(state: IncidentState): Promise<Partial<IncidentState>> {
  const value = interrupt({
    type: "await_input",
    incidentId: state.incidentId,
    status: state.status,
  } satisfies InterruptPayload);

  if (
    (typeof value === "object" && value !== null && (value as { closeRequested?: unknown }).closeRequested === true) ||
    state.closeRequested
  ) {
    return { closeRequested: true };
  }
  if (typeof value === "string" && value.trim()) {
    return { timeline: [{ t: new Date(), source: "medic", text: value }] };
  }
  if (typeof value === "object" && value !== null && "text" in value) {
    const text = String((value as { text: unknown }).text ?? "");
    if (text.trim()) return { timeline: [{ t: new Date(), source: "medic", text }] };
  }
  return {};
}

export async function postmortemNode(state: IncidentState): Promise<Partial<IncidentState>> {
  const postmortemId = await (await memory()).generateAndWrite(state.incidentId);
  const draft = await (await memory()).draftPcr(state.incidentId);
  const preview = draft.text.split(/\s+/).slice(0, 40).join(" ");

  await (await events()).emit({
    kind: "pcr",
    incidentId: state.incidentId,
    payload: { postmortemId, preview },
  });

  return { nodeTrail: ["postmortem"] };
}
