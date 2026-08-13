import {
  DECISIONS,
  INCIDENTS,
  PUBLIC_INCIDENT_PROJECTION,
  type IncidentDoc,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { events, llm, memory } from "@/lib/registry";
import { countIn } from "./counts";

export interface ExtractedDecision {
  actionChosen: string;
  /** `null` when the medic gave no reason. NEVER fabricate one. */
  rationale: string | null;
  optionsConsidered: string[];
}

/**
 * Extraction is duplicated across PHASE-11 and PHASE-13 (a route handler cannot import a
 * module from a phase that may not exist yet); the database write is not — that is
 * `MemoryPort.recordDecision`, which PHASE-09 owns. The three field names and the `null`
 * convention are load-bearing across that boundary because the same shape feeds the port from
 * either copy.
 *
 * The prompt deliberately avoids the words a reason usually arrives in, so nothing in the
 * instruction text can be mistaken for the medic's own words by a downstream check.
 */
const EXTRACTION_PROMPT = (utterance: string): string => `Extract the decision from one EMS medic utterance.

Return JSON with exactly these keys:
- actionChosen: a short clinical action phrase, in the medic's own terms.
- rationale: the medic's stated reason, copied as a contiguous verbatim span of the utterance.
  If the medic gave no reason, this is null. This is a rule, not a preference: a rationale that
  is not literally present in the utterance is an invention, and an invented justification in a
  permanent clinical record is the exact harm this system exists to prevent.
- optionsConsidered: other options the medic named out loud, otherwise an empty array.

Do not judge the action. Do not add clinical advice. Do not label a protocol violation.

Utterance: ${utterance}`;

/** No `example` key: the fake LLM short-circuits to `schema.example` when one is present. */
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actionChosen", "rationale", "optionsConsidered"],
  properties: {
    actionChosen: { type: "string" },
    rationale: { type: ["string", "null"] },
    optionsConsidered: { type: "array", items: { type: "string" } },
  },
} as const;

/** `rationale` must be a contiguous span of the utterance, compared case-insensitively and trimmed. */
function isVerbatimSpan(rationale: string, utterance: string): boolean {
  const span = rationale.trim().toLowerCase();
  return span.length > 0 && utterance.trim().toLowerCase().includes(span);
}

export async function extractDecision(utterance: string): Promise<ExtractedDecision> {
  let raw: unknown = null;
  try {
    raw = await (await llm()).json<unknown>(EXTRACTION_PROMPT(utterance), EXTRACTION_SCHEMA);
  } catch (err) {
    console.error(
      `[tool] decision extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const obj = (raw ?? {}) as Partial<Record<keyof ExtractedDecision, unknown>>;

  // Fall back to the medic's own sentence rather than an empty action; still their words.
  const actionChosen =
    typeof obj.actionChosen === "string" && obj.actionChosen.trim()
      ? obj.actionChosen.trim()
      : utterance.trim();

  // A model told not to invent will still occasionally paraphrase a reason into existence, and
  // a paraphrase absent from the medic's words is indistinguishable from an invention once it
  // is in the database. Discard it rather than repair it.
  let rationale: string | null = null;
  if (typeof obj.rationale === "string" && isVerbatimSpan(obj.rationale, utterance)) {
    rationale = obj.rationale.trim();
  }

  const optionsConsidered = Array.isArray(obj.optionsConsidered)
    ? obj.optionsConsidered.filter((o): o is string => typeof o === "string" && o.trim() !== "")
    : [];

  return { actionChosen, rationale, optionsConsidered };
}

/**
 * Fired by `record_decision` *after* the response is sent — the medic cannot wait on an
 * embedding round trip before the next sentence.
 *
 * The insert itself is `MemoryPort.recordDecision`: the port embeds, sets both `embedding` and
 * `embeddedText`, and enforces the rationale rule in process. Hand-rolling the insert here
 * would produce a second decision writer that skips PHASE-09's guard.
 */
export async function writeDecisionInBackground(input: {
  incidentId: string;
  utterance: string;
}): Promise<void> {
  try {
    const incident = await col<{ [K in keyof IncidentDoc]: IncidentDoc[K] }>(INCIDENTS).findOne(
      { incidentId: input.incidentId },
      { projection: PUBLIC_INCIDENT_PROJECTION },
    );

    if (!incident) {
      console.error(`DECISION WRITE FAILED: unknown incident ${input.incidentId}`);
      return;
    }

    const extracted = await extractDecision(input.utterance);

    if (!extracted.rationale || !extracted.rationale.trim()) {
      // Critical Rule 4. Three layers agree — this check, the port's `MISSING_RATIONALE:`
      // throw, and the server-side JSON Schema validator. This is the first of them.
      console.warn(`DECISION WRITE SKIPPED: empty rationale (${input.incidentId})`);
      return;
    }

    const decisionId = await (await memory()).recordDecision({
      incidentId: input.incidentId,
      utterance: input.utterance,
      actionChosen: extracted.actionChosen,
      rationale: extracted.rationale,
      optionsConsidered: extracted.optionsConsidered,
      outcome: "pending",
    });

    const bus = await events();
    await bus.emit({
      kind: "decision",
      incidentId: input.incidentId,
      payload: {
        decisionId,
        actionChosen: extracted.actionChosen,
        rationaleRecorded: true,
        // Never an extraction output: labelling a medic's action a protocol violation from one
        // sentence is exactly the clinical judgment the scope guardrail forbids.
        protocolConflict: false,
      },
    });
    await bus.emit({
      kind: "write",
      incidentId: null,
      payload: { collection: DECISIONS, count: await countIn(DECISIONS) },
    });
  } catch (err) {
    console.error(
      `DECISION WRITE FAILED ${input.incidentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
