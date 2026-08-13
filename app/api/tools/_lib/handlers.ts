import {
  CloseCallReq,
  ConfirmReadbackReq,
  GetProtocolReq,
  INCIDENTS,
  LogTimelineReq,
  POSTMORTEMS,
  PUBLIC_INCIDENT_PROJECTION,
  ProposeReadbackReq,
  RecallMemoryReq,
  RecordDecisionReq,
  SPOKEN_WORD_CAP,
  labelFor,
  type GraphNode,
  type Hit,
  type IncidentDoc,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { events, graph, memory, retrieval } from "@/lib/registry";
import { composeReadback } from "./readback";
import { countIn } from "./counts";
import { writeDecisionInBackground } from "./decision-write";

export type ToolName =
  | "recall_memory"
  | "get_protocol"
  | "log_timeline"
  | "propose_readback"
  | "confirm_readback"
  | "record_decision"
  | "close_call";

export const TOOL_NAMES: readonly ToolName[] = [
  "recall_memory",
  "get_protocol",
  "log_timeline",
  "propose_readback",
  "confirm_readback",
  "record_decision",
  "close_call",
];

type ToolResult = { status: number; json: unknown };

/** Structural stand-in for `ZodError` so this file needs no zod import. */
type IssueBag = { issues: readonly { path: readonly PropertyKey[]; message: string }[] };

function badRequest(err: IssueBag): ToolResult {
  const message = err.issues
    .map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  return { status: 400, json: { error: message } };
}

/** ≤ `max` words, trimmed. A 200-word guideline chunk at TTS pace is 90 seconds of dead air. */
function capWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : words.slice(0, max).join(" ");
}

/**
 * The driver's generic requires an index signature, which an `interface` never gets
 * implicitly. Mapping over `IncidentDoc` produces a type alias that does, without restating a
 * single field or widening one.
 */
type IncidentRecord = { [K in keyof IncidentDoc]: IncidentDoc[K] };

/** Every agent-facing incident read goes through the projection; the answers stay quarantined. */
async function loadIncident(incidentId: string): Promise<IncidentDoc | null> {
  return col<IncidentRecord>(INCIDENTS).findOne(
    { incidentId },
    { projection: PUBLIC_INCIDENT_PROJECTION },
  );
}

/**
 * `voice.payload.clock` is the call clock, independent of the header elapsed timer (which the
 * dashboard derives from `status.payload.startedAt`) — `04:42` vs `44:31` in the pixel reference.
 */
function callClock(incident: IncidentDoc | null): string {
  const started = incident?.createdAt ? new Date(incident.createdAt).getTime() : Date.now();
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function recallMemory(body: unknown): Promise<ToolResult> {
  const parsed = RecallMemoryReq.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { incidentId, query } = parsed.data;

  const incident = await loadIncident(incidentId);
  const hits = await (await retrieval()).fanOut(
    query,
    incident ? { callTypeFamily: incident.callTypeFamily } : undefined,
  );

  const capped: Hit[] = hits.map((h) => ({ ...h, spoken: capWords(h.spoken, SPOKEN_WORD_CAP) }));
  const top = capped[0];
  // The literal string matters: with `decisions` empty the agent must be able to say it has no
  // prior record, and must not cite a displayId it was never given.
  const summary = top ? capWords(top.spoken, 25) : "new signature, no prior history";
  const spoken = top ? capWords(top.spoken, SPOKEN_WORD_CAP) : summary;

  await (await events()).emit({
    kind: "retrieval",
    incidentId,
    payload: { query, hits: capped },
  });

  return { status: 200, json: { summary, spoken, hits: capped } };
}

async function getProtocol(body: unknown): Promise<ToolResult> {
  const parsed = GetProtocolReq.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { topic } = parsed.data;

  const hits = await (await retrieval()).fanOut(topic);
  const runbook = hits.find((h) => h.source === "runbooks");

  // A missing guideline is a normal retrieval miss, not a missing route — 200, not 404.
  if (!runbook) {
    return {
      status: 200,
      json: { spoken: "No matching protocol section.", text: "", sectionTitle: "", pageStart: 0 },
    };
  }

  const pageStart = typeof runbook.meta.pageStart === "number" ? runbook.meta.pageStart : 0;
  return {
    status: 200,
    json: {
      // Attribution the agent can read aloud; it may only quote guidance, never author it.
      spoken: capWords(`From NASEMSO, ${runbook.spoken}`, SPOKEN_WORD_CAP),
      text: runbook.text,
      sectionTitle: runbook.title,
      pageStart,
    },
  };
}

async function logTimeline(body: unknown): Promise<ToolResult> {
  const parsed = LogTimelineReq.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { incidentId, text, source } = parsed.data;

  const now = new Date();
  const updated = await col<IncidentRecord>(INCIDENTS).findOneAndUpdate(
    { incidentId },
    { $push: { timeline: { t: now, source, text } }, $set: { updatedAt: now } },
    { returnDocument: "after", projection: PUBLIC_INCIDENT_PROJECTION },
  );

  if (!updated) {
    console.warn(`[tool] log_timeline: unknown incident ${incidentId}`);
    return { status: 200, json: { ok: true } };
  }

  const bus = await events();
  if (source === "medic" || source === "agent") {
    await bus.emit({
      kind: "voice",
      incidentId,
      payload: { speaker: source, text, clock: callClock(updated) },
    });
  }
  // `timeline` is a display bucket, not a collection: `reference.png` shows the tile, PHASE-12
  // watches collections and `/api/counters` counts collections, so this handler is the only
  // thing that can produce it. Absolute length, not a delta.
  await bus.emit({
    kind: "write",
    incidentId: null,
    payload: { collection: "timeline", count: updated.timeline?.length ?? 0 },
  });

  return { status: 200, json: { ok: true } };
}

async function proposeReadback(body: unknown): Promise<ToolResult> {
  const parsed = ProposeReadbackReq.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { incidentId, utterance, drug, dose, route } = parsed.data;

  // Deterministic string formatting only. No LLM on this path — the agent speaks this
  // verbatim on this turn and a paraphrased dose is a clinical error.
  const readbackText = composeReadback({ utterance, drug, dose, route });

  await (await events()).emit({
    kind: "readback",
    incidentId,
    payload: { state: "awaiting", readbackText },
  });

  return { status: 200, json: { readbackText } };
}

async function confirmReadback(body: unknown): Promise<ToolResult> {
  const parsed = ConfirmReadbackReq.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { incidentId, confirmed, verbatimOk } = parsed.data;

  let resumedAt: GraphNode | null = null;
  let ok = false;
  try {
    const result = await (await graph()).resume(incidentId, { confirmed, verbatimOk });
    resumedAt =
      result.interrupt === null
        ? "execute_record"
        : result.interrupt.type === "readback"
          ? "readback_gate"
          : null;
    ok = true;
  } catch (err) {
    // A graph failure must not kill the voice turn mid-demo.
    console.error(
      `[tool] confirm_readback resume failed ${incidentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await (await events()).emit({
    kind: "readback",
    incidentId,
    payload: { state: confirmed ? "confirmed" : "rejected", readbackText: "" },
  });

  return { status: 200, json: { ok, resumedAt } };
}

async function recordDecision(body: unknown): Promise<ToolResult> {
  const parsed = RecordDecisionReq.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { incidentId, utterance } = parsed.data;

  // Acknowledge now, extract and write after. The medic cannot wait on an embedding round
  // trip before the next sentence.
  setImmediate(() => {
    void writeDecisionInBackground({ incidentId, utterance });
  });

  return { status: 200, json: { ok: true, ack: "Recorded." } };
}

async function closeCall(body: unknown): Promise<ToolResult> {
  const parsed = CloseCallReq.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { incidentId } = parsed.data;

  // PHASE-09's close path, through the port: `generateAndWrite` then `draftPcr`. The port
  // writes the postmortem with `origin: "live"`, which is exactly what lets
  // `/api/demo/reset` delete it without touching the seeded corpus — the two routes are
  // coupled through that one field.
  const mem = await memory();
  const postmortemId = await mem.generateAndWrite(incidentId);
  const { text } = await mem.draftPcr(incidentId);
  const pcrPreview = text.length > 400 ? `${text.slice(0, 400).trimEnd()}…` : text;

  const now = new Date();
  const incident = await col<IncidentRecord>(INCIDENTS).findOneAndUpdate(
    { incidentId },
    { $set: { status: "closed", updatedAt: now } },
    { returnDocument: "after", projection: PUBLIC_INCIDENT_PROJECTION },
  );

  const bus = await events();
  await bus.emit({ kind: "pcr", incidentId, payload: { postmortemId, preview: pcrPreview } });
  if (incident) {
    await bus.emit({
      kind: "status",
      incidentId,
      payload: {
        status: "closed",
        ref: incident.ref,
        label: labelFor(incident.cad.initialCallType),
        dispatchArea: incident.cad.dispatchArea,
        unit: incident.cad.unit,
        startedAt: new Date(incident.createdAt),
      },
    });
  }
  await bus.emit({
    kind: "write",
    incidentId: null,
    payload: { collection: POSTMORTEMS, count: await countIn(POSTMORTEMS) },
  });

  return { status: 200, json: { postmortemId, pcrPreview } };
}

const HANDLERS: Record<ToolName, (body: unknown) => Promise<ToolResult>> = {
  recall_memory: recallMemory,
  get_protocol: getProtocol,
  log_timeline: logTimeline,
  propose_readback: proposeReadback,
  confirm_readback: confirmReadback,
  record_decision: recordDecision,
  close_call: closeCall,
};

function isToolName(tool: string): tool is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(tool);
}

export async function handleTool(tool: string, body: unknown): Promise<ToolResult> {
  if (!isToolName(tool)) {
    return { status: 404, json: { error: "unknown tool" } };
  }
  // The one line that separates a real agent from a TTS layer reading pre-generated text.
  // PHASE-13's acceptance greps for it, and speech alone is not evidence.
  console.log(`[tool] ${tool}`);
  return HANDLERS[tool](body);
}
