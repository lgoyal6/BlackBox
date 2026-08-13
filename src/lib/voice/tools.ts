import { llm } from "@/lib/registry";

export interface DecisionExtraction {
  actionChosen: string;
  /** `null` when the medic gave no reason. NEVER fabricate. */
  rationale: string | null;
  optionsConsidered: string[];
}

/**
 * The one piece of real local logic, plus the deterministic readback formatter.
 *
 * PHASE-11 carries a second copy of both, in `app/api/tools/_lib/readback.ts` and
 * `app/api/tools/_lib/decision-write.ts`, because a route handler cannot import a module from a
 * phase that may not exist yet. Extraction is duplicated; the database write is not — that is
 * `MemoryPort.recordDecision`, and both copies hand it an already-split decision.
 *
 * The three field names and the `null` convention are load-bearing across that boundary.
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

/**
 * `protocolConflict` is deliberately absent: labelling a medic's action a protocol violation
 * from one sentence is exactly the clinical judgment the scope guardrail forbids. It defaults
 * to `false` on the written document and the LLM never sets it.
 *
 * No `example` key — the fake LLM short-circuits to `schema.example` when one is present.
 */
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

/** Case-insensitive, trimmed containment check. */
function isVerbatimSpan(rationale: string, utterance: string): boolean {
  const span = rationale.trim().toLowerCase();
  return span.length > 0 && utterance.trim().toLowerCase().includes(span);
}

/**
 * One small fast LLM call with a strict schema, run inside `record_decision`'s background task
 * while the medic is still talking.
 *
 * Do not rely on the prompt alone: a model asked not to invent will still occasionally
 * paraphrase a reason into existence, and a paraphrase absent from the medic's own words is
 * indistinguishable from an invention once it is in the database. The substring guard below is
 * what actually protects the clinical record.
 */
export async function extractRationale(utterance: string): Promise<DecisionExtraction> {
  let raw: unknown = null;
  try {
    raw = await (await llm()).json<unknown>(EXTRACTION_PROMPT(utterance), EXTRACTION_SCHEMA);
  } catch (err) {
    console.error(
      `[voice] rationale extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const obj = (raw ?? {}) as Partial<Record<keyof DecisionExtraction, unknown>>;

  const actionChosen =
    typeof obj.actionChosen === "string" && obj.actionChosen.trim()
      ? obj.actionChosen.trim()
      : utterance.trim();

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
 * Deterministic string formatting. NEVER an LLM call, because the agent speaks this verbatim on
 * this turn and an LLM can paraphrase a dose or round a number. Verbatim means verbatim.
 *
 * Pinned by an identical assertion in PHASE-11's spec:
 *
 *   composeReadback({ drug: "amiodarone", dose: "300 mg", route: "IV push" })
 *     === "Confirm: 300 mg of amiodarone, IV push. Say confirm."
 */
export function composeReadback(f: {
  drug?: string;
  dose?: string;
  route?: string;
  utterance?: string;
}): string {
  const dose = f.dose?.trim();
  const drug = f.drug?.trim();
  const route = f.route?.trim();

  const med = [dose, drug].filter(Boolean).join(" of ");
  const clauses = [med, route].filter(Boolean);
  const body = clauses.length > 0 ? clauses.join(", ") : (f.utterance ?? "").trim();

  return `Confirm: ${body}. Say confirm.`;
}
