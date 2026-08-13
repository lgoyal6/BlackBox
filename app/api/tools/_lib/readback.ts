/**
 * Deterministic readback formatter. No model call, no `fetch`, no randomness.
 *
 * The agent speaks this string verbatim on the same turn, and an LLM will paraphrase
 * "1 milligram" into "one mg" or round a number — a clinical error and a failed demo beat.
 * This is the aviation-style readback and the LangGraph human-in-the-loop gate.
 *
 * PHASE-13 owns the canonical copy at `src/lib/voice/tools.ts`. Both specs pin the same
 * assertion, which is what stops the two from drifting:
 *
 *   composeReadback({ drug: "amiodarone", dose: "300 mg", route: "IV push" })
 *     === "Confirm: 300 mg of amiodarone, IV push. Say confirm."
 *
 * Changing the wording is a contract change: stop, edit `contracts.md`, log it in `agents.md`.
 */
export function composeReadback(fields: {
  utterance: string;
  drug?: string;
  dose?: string;
  route?: string;
}): string {
  // Copy the dose and units character for character. No unit conversion, no rounding, and no
  // spelling out a digit that arrived as a digit.
  const dose = fields.dose?.trim();
  const drug = fields.drug?.trim();
  const route = fields.route?.trim();

  const med = [dose, drug].filter(Boolean).join(" of ");
  const clauses = [med, route].filter(Boolean);
  const body = clauses.length > 0 ? clauses.join(", ") : fields.utterance.trim();

  return `Confirm: ${body}. Say confirm.`;
}
